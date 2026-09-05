import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { AuthRuntime } from '../services/auth-runtime.js';
import { CSRF_HEADER, csrfTokenFor } from '../services/csrf.service.js';
import { hashToken } from '../services/session.service.js';
import { timingSafeEqualStrings } from '../utils/timing-safe.js';
import { HttpError } from './auth.js';

/** Methods that can change state. Safe methods carry no CSRF risk by definition. */
const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Double-submit CSRF, bound to the session.
 *
 * The cookie half is written by the cookie jar in the same call that writes the
 * session cookie (`plugins/cookies.ts`), so the two can never drift: any code path
 * that issues or rotates a session issues a matching CSRF token, and no route
 * spells either cookie's name.
 *
 * Three things must agree on a mutating request:
 *
 * 1. the non-`HttpOnly` `…panel_csrf` cookie,
 * 2. the `X-CSRF-Token` header, and
 * 3. the value derived from the session cookie actually presented —
 *    `csrfTokenFor(session.id, sha256(sessionToken))`.
 *
 * Point 3 is what makes this more than a same-origin-writability check: a token
 * lifted from another session, or a value an attacker wrote into the cookie jar
 * from a sibling origin, matches (1) and (2) but not (3). Both comparisons are
 * constant-time, because both compare a client-supplied string against a secret.
 *
 * Requests with **no** session are exempt. Login has no session to bind a token
 * to, and there is nothing to protect: `SameSite=Strict` plus the `Origin` check
 * already stop a cross-site login attempt, and a forged login into the attacker's
 * own account gains nothing here — there is exactly one account. The moment stage
 * one succeeds the response carries both cookies, so stage two is covered.
 */
export function requireCsrfToken(runtime: AuthRuntime): onRequestAsyncHookHandler {
  return async function csrfHook(req: FastifyRequest): Promise<void> {
    if (!MUTATING_METHODS.has(req.method)) return;
    if (req.session === null) return;

    const sessionToken = runtime.cookies.readSession(req);
    if (sessionToken === null) throw new HttpError(403, 'csrf token missing', 'csrf_invalid');

    const expected = csrfTokenFor(req.session.id, hashToken(sessionToken));

    const header = req.headers[CSRF_HEADER];
    const presented = typeof header === 'string' ? header : null;
    if (presented === null) throw new HttpError(403, 'csrf token missing', 'csrf_invalid');

    const cookie = runtime.cookies.readCsrf(req);
    if (cookie === null) throw new HttpError(403, 'csrf cookie missing', 'csrf_invalid');

    // Both halves, both constant-time. Checking the header against the cookie as
    // well as against the expected value costs one more comparison and keeps the
    // "double submit" property meaningful for a client that sends a stale pair.
    if (!timingSafeEqualStrings(presented, expected)) throw new HttpError(403, 'csrf token mismatch', 'csrf_invalid');
    if (!timingSafeEqualStrings(cookie, expected)) throw new HttpError(403, 'csrf cookie mismatch', 'csrf_invalid');
  };
}
