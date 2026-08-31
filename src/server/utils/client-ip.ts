import type { FastifyRequest } from 'fastify';

/**
 * The client IP, for display and audit metadata **only**.
 *
 * This is the single place in the application that reads the client address, and
 * it exists so that fact is enforceable: `tests/integration/no-ip-decisions.test.ts`
 * asserts that no route, service, or plugin outside this file (and the log
 * serialiser, which records it as a log field) touches `req.ip`, `remoteAddress`,
 * or `x-forwarded-for`.
 *
 * Why no security decision may be made from it: the operator reaches this panel
 * through tunnels with rotating addresses, so per-IP rate limiting or lockout
 * would lock out the one legitimate user while an attacker rotates addresses at
 * no cost. The progressive delay in `services/auth-delay.service.ts` is keyed on
 * nothing at all, which is exactly why it cannot be evaded by changing address.
 *
 * The value is also not trustworthy: with `PANEL_TRUST_PROXY` on (the Railway
 * default) it comes from `X-Forwarded-For`, which any client can set. Recording
 * an attacker-controlled string for the operator to look at is fine. Branching on
 * one is not.
 */
export function clientIpForDisplay(req: FastifyRequest): string | null {
  const value = req.ip;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The user agent, for display and audit metadata only. Truncated, never parsed. */
export function userAgentForDisplay(req: FastifyRequest): string | null {
  const value = req.headers['user-agent'];
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.slice(0, 256);
}
