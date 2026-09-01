import type { FastifyInstance } from 'fastify';
import { requireFullSession } from '../plugins/auth.js';
import type { AuthRuntime } from '../services/auth-runtime.js';
import { auditQuery, parseBody } from '../utils/zod-schemas.js';
import type { AuditPageResponse, AuditVerifyResponse } from '../../shared/types.js';

/**
 * Reading the audit log.
 *
 * Both routes need a **full** session: a `pre` session has passed one factor, and
 * the log is a record of every authentication attempt, every session, and every
 * secret access — precisely what an attacker holding a stolen password would like
 * to read before deciding what to do next. Neither route is step-up gated, because
 * reading is not a state change and requiring a fresh code to look at the log would
 * push the operator toward not looking.
 *
 * There is no write route and never will be. The only way a row appears is through
 * `AuditService.write`, and migration 008's triggers stop this connection from
 * updating or deleting one at all.
 */
export default async function auditRoutes(
  app: FastifyInstance,
  opts: { runtime: AuthRuntime },
): Promise<void> {
  const { runtime } = opts;

  app.get('/api/audit', { preHandler: requireFullSession }, async (req) => {
    const q = parseBody(auditQuery, req.query);
    const events = q.event === undefined ? undefined : Array.isArray(q.event) ? q.event : [q.event];

    const page = runtime.audit.query({
      limit: q.limit,
      cursor: q.cursor,
      events,
      from: q.from,
      to: q.to,
    });

    const response: AuditPageResponse = {
      entries: page.entries.map((entry) => ({
        id: entry.id,
        ts: entry.ts,
        event: entry.event,
        outcome: entry.outcome,
        actorIp: entry.actorIp,
        userAgent: entry.userAgent,
        meta: entry.meta,
      })),
      nextCursor: page.nextCursor,
    };
    return response;
  });

  /**
   * The integrity report.
   *
   * Walks the entire chain — deliberately not cached, since a cached answer to "has
   * my audit log been tampered with" is worth nothing. At the row cap this is a
   * bounded scan of one small table.
   */
  app.get('/api/audit/verify', { preHandler: requireFullSession }, async () => {
    const result = runtime.audit.verify();
    const response: AuditVerifyResponse = {
      ok: result.ok,
      checked: result.checked,
      head: result.head,
      floor: result.floor,
      floorId: result.floorId,
      reason: result.reason,
      brokenAtId: result.brokenAtId,
    };
    return response;
  });
}
