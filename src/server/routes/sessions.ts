import type { FastifyInstance } from 'fastify';
import { AuditEvent } from '../services/audit.service.js';
import type { AuthRuntime } from '../services/auth-runtime.js';
import { HttpError, clearSessionCookie, requireFullSession } from '../plugins/auth.js';
import { clientIpForDisplay, userAgentForDisplay } from '../utils/client-ip.js';
import { parseBody, sessionIdParams } from '../utils/zod-schemas.js';
import { toSessionSummary } from './auth.js';
import type { RevokedResponse, SessionListResponse } from '../../shared/types.js';

/**
 * Session management.
 *
 * The whole reason the session token is opaque and server-side rather than a JWT:
 * revocation here takes effect on the next request, with no window in which a
 * signed-but-revoked token is still honoured.
 *
 * `ip` and `userAgent` come back in the listing because the operator needs to
 * recognise "that's my laptop" and "that is not". They are recorded from
 * attacker-controllable input (`X-Forwarded-For` behind the proxy) and nothing
 * decides anything from them — see `utils/client-ip.ts`.
 */
export default async function sessionRoutes(
  app: FastifyInstance,
  opts: { runtime: AuthRuntime },
): Promise<void> {
  const { runtime } = opts;
  const { basePath } = runtime;

  app.get('/api/sessions', { preHandler: requireFullSession }, async (req) => {
    const current = req.session!;
    const response: SessionListResponse = {
      sessions: runtime.sessions.list().map((s) => toSessionSummary(s, current.id)),
    };
    return response;
  });

  // Revoking the current session is allowed and behaves as a logout, cookie
  // cleared included. Refusing it would be a surprise, not a safeguard.
  app.delete('/api/sessions/:id', { preHandler: requireFullSession }, async (req, reply) => {
    const { id } = parseBody(sessionIdParams, req.params);
    const current = req.session!;

    const removed = runtime.sessions.revoke(id);
    if (!removed) throw new HttpError(404, 'no such session');

    runtime.audit.write({
      event: AuditEvent.SessionRevoked,
      outcome: 'success',
      actorIp: clientIpForDisplay(req),
      userAgent: userAgentForDisplay(req),
      meta: { sessionId: id, self: id === current.id },
    });

    if (id === current.id) clearSessionCookie(reply, basePath);
    return reply.code(204).send();
  });

  app.post('/api/sessions/revoke-others', { preHandler: requireFullSession }, async (req) => {
    const current = req.session!;
    const revoked = runtime.sessions.revokeOthers(current.id);

    runtime.audit.write({
      event: AuditEvent.SessionRevoked,
      outcome: 'success',
      actorIp: clientIpForDisplay(req),
      userAgent: userAgentForDisplay(req),
      meta: { keptSessionId: current.id, revoked, reason: 'revoke_others' },
    });

    const response: RevokedResponse = { revoked };
    return response;
  });
}
