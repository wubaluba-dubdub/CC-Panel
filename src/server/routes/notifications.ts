import type { FastifyInstance } from 'fastify';
import { HttpError, requireFullSession } from '../plugins/auth.js';
import type { AuthRuntime } from '../services/auth-runtime.js';
import type { NotifyService } from '../services/notify.service.js';
import { TELEGRAM_SCOPE, telegramConfigStatus } from '../services/telegram-config.js';
import { parseBody, queueIdParams } from '../utils/zod-schemas.js';
import type { NotificationStatusResponse, NotificationQueuedResponse } from '../../shared/types.js';

/**
 * Reading the notification configuration, and sending a test message.
 *
 * **There is no route here that writes the credentials, and that is deliberate.** The
 * bot token and the chat id are stored secrets like any other, so they are written
 * through `PUT /api/secrets` with scope `telegram` — which is already step-up gated,
 * already audited as `secret.changed`, and already swept by the sentinel test. A second
 * endpoint doing the same writes would be a second thing to gate correctly and a second
 * thing to get wrong, and M2.5's UI needs no more than what exists.
 *
 * Sending a test message needs a **full session but not step-up**: it discloses nothing
 * — the operator's own phone receives a fixed sentence — and requiring a fresh code to
 * check whether notifications work would push them toward not checking.
 */
export default async function notificationRoutes(
  app: FastifyInstance,
  opts: { runtime: AuthRuntime; notify: NotifyService },
): Promise<void> {
  const { runtime, notify } = opts;

  /**
   * Set or not set, and a length. **Never `mask()`.**
   *
   * `mask()` reveals the last four characters, which is harmless for a 46-character bot
   * token and is not harmless for a nine-digit chat id, where four digits is a
   * meaningful fraction of a stable identifier for the operator's Telegram account. The
   * rule the audit log already follows applies here for the same reason: a display form
   * that accumulates is a partial disclosure that cannot be undone.
   */
  app.get('/api/notifications/telegram', { preHandler: requireFullSession }, async () => {
    const config = telegramConfigStatus(runtime.secrets);
    const response: NotificationStatusResponse = {
      configured: config.configured,
      botToken: config.botToken,
      chatId: config.chatId,
      includeLinks: runtime.env.PANEL_NOTIFY_INCLUDE_LINKS,
      locale: runtime.env.PANEL_NOTIFY_LOCALE,
      queue: notify.counts(),
      dropped: notify.dropped(),
      lastSuccessAt: notify.lastSuccessAt(),
      lastFailure: notify.lastFailure(),
    };
    return response;
  });

  /**
   * Enqueues a test message and answers immediately.
   *
   * `202`, not `200`, and deliberately not synchronous: a synchronous send would make
   * this endpoint's response time a function of a third party's availability, and the
   * whole point of the queue is that nothing in a request path ever waits on
   * `api.telegram.org`. Poll the queue row, or just look at your phone.
   */
  app.post('/api/notifications/test', { preHandler: requireFullSession }, async (req, reply) => {
    const result = notify.notify({ kind: 'test', at: new Date(runtime.clock.now()).toISOString() });
    if (result.queued === null) throw new HttpError(503, `notification queue is ${result.reason}`);

    const response: NotificationQueuedResponse = { queued: result.queued };
    void req;
    return reply.code(202).send(response);
  });

  /** The outcome of one queued notification. A category for a failure, never a body. */
  app.get('/api/notifications/queue/:id', { preHandler: requireFullSession }, async (req) => {
    const { id } = parseBody(queueIdParams, req.params);
    const row = notify.row(id);
    if (row === null) throw new HttpError(404, 'no such queue row');
    return row;
  });

  void TELEGRAM_SCOPE;
}
