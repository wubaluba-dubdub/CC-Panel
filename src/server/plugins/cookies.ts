import type { FastifyReply, FastifyRequest } from 'fastify';
import { csrfTokenFor } from '../services/csrf.service.js';
import {
  IDLE_TIMEOUT_MS,
  PRE_AUTH_LIFETIME_MS,
  hashToken,
  type SessionRecord,
} from '../services/session.service.js';
import { type Clock, msFromIso, systemClock } from '../utils/clock.js';
import type { PublicOrigin } from '../utils/public-origin.js';

/**
 * Every cookie this panel sets is named and assembled here, and nowhere else.
 *
 * `tests/integration/cookie-discipline.test.ts` enforces that by scanning every
 * file under `src/server` for a cookie-name literal, a `setCookie`/`clearCookie`
 * call, or a direct read of the cookie jar. This file is the only exemption.
 *
 * The reason for the choke point is the bug that prompted it. The name was a
 * constant in `session.service.ts` and the attributes were a helper in
 * `plugins/auth.ts` that hard-coded `secure: true` — a pair that is correct in
 * production and unusable in local development, and no single place owned the
 * decision well enough for that to be visible.
 */

/** Base names. The `__Secure-` prefix is added by {@link cookieProfileFor}. */
export const COOKIE_BASE_NAMES = {
  session: 'panel_session',
  csrf: 'panel_csrf',
} as const;

export const SECURE_PREFIX = '__Secure-';

export type CookieKind = keyof typeof COOKIE_BASE_NAMES;

export interface CookieProfile {
  /** The `Secure` attribute, and by implication the name prefix. */
  readonly secure: boolean;
  /** `__Secure-` or the empty string. */
  readonly prefix: string;
}

/**
 * Chooses between the two cookie profiles, or refuses.
 *
 * **Why there are two.** The `__Secure-` name prefix and the `Secure` attribute
 * are separate things, and browsers do not treat them alike over loopback.
 * Chrome accepts a `Secure` cookie on `http://127.0.0.1` — loopback is a
 * potentially-trustworthy origin — but it does *not* extend that concession to
 * the `__Secure-` **name** prefix, whose rule is unconditionally "must arrive over
 * a secure scheme". The cookie is dropped, silently, with nothing in the network
 * panel to say so: the `Set-Cookie` header is present and correct and the cookie
 * simply never appears in the jar. Firefox accepts it; Safari rejects both. The
 * server's header was never wrong — the *name* was unusable over http, which made
 * login impossible in Chrome against a local dev server and would have blocked
 * client development in M2 outright.
 *
 * **Why the weak profile cannot leak into production.** This function is the only
 * way to reach it, and it throws for `NODE_ENV=production`. That check is
 * deliberately redundant with the one in `resolvePublicOrigin`, which already
 * refuses to boot on a non-https origin in production: two independent guards, so
 * removing either one still fails a test. It also throws for a non-loopback http
 * origin at any `NODE_ENV`, because "http and routable" is the case where dropping
 * `Secure` hands the cookie to the network.
 *
 * **Why not `__Host-`.** It is the stronger prefix — host-only, no `Domain`, and
 * proof against a sibling subdomain writing the cookie — but it mandates `Path=/`.
 * This cookie is scoped to `Path=/<basePath>` so that it is not attached to
 * `/healthz`, and so that the secret prefix is the only path a request carrying it
 * can be aimed at. Widening the path to `/` to gain the prefix would send the
 * session cookie to every request outside the prefix, including the one route an
 * unauthenticated caller is meant to reach. The trade is recorded in
 * `docs/SECURITY.md`.
 */
export function cookieProfileFor(origin: PublicOrigin, nodeEnv: string): CookieProfile {
  if (origin.secure) return { secure: true, prefix: SECURE_PREFIX };

  if (nodeEnv === 'production') {
    throw new Error(
      `FATAL: refusing to issue a non-Secure session cookie with NODE_ENV=production ` +
        `(public origin ${origin.origin}). Serve the panel over https.`,
    );
  }
  if (!origin.loopback) {
    throw new Error(
      `FATAL: refusing to issue a non-Secure session cookie for the non-loopback origin ` +
        `${origin.origin}. Serve the panel over https, or bind it to loopback.`,
    );
  }
  return { secure: false, prefix: '' };
}

interface CookieAttributes {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict';
  path: string;
  maxAge: number;
}

/**
 * The cookie lifetime, in seconds: the sliding idle window, clamped to what is
 * left of the absolute deadline.
 *
 * Chosen rather than omitted. A cookie with no `Max-Age` is a "session cookie",
 * which sounds like "gone when the browser closes" and is not: Chrome's session
 * restore, and Firefox's, put session cookies back after a restart, so omitting
 * the attribute is a guarantee about nothing. Stating it makes the client's copy
 * expire on the same schedule the server's row does — the server row is still the
 * only authority, and it is the one an attacker holding a stolen cookie cannot
 * extend, but a client that discards the value on time is one fewer copy sitting
 * on disk.
 *
 * The clamp is what keeps this honest: a `full` session refreshed at every request
 * would otherwise hand out an eight-hour cookie for a session with ten minutes of
 * absolute lifetime left. Never more than `ABSOLUTE_LIFETIME_MS`, and
 * `tests/integration/cookies.test.ts` asserts that on a session near its absolute
 * deadline.
 */
export function cookieMaxAgeSeconds(session: SessionRecord, nowMs: number): number {
  const idleMs = session.authLevel === 'pre' ? PRE_AUTH_LIFETIME_MS : IDLE_TIMEOUT_MS;
  const absolute = msFromIso(session.absoluteExpiresAt);
  const remaining = Number.isNaN(absolute) ? idleMs : absolute - nowMs;
  // At least one second: a zero or negative Max-Age is an instruction to delete
  // the cookie, and the caller asking to set one means the session is still live.
  return Math.max(1, Math.floor(Math.min(idleMs, remaining) / 1000));
}

export interface CookieJar {
  readonly sessionName: string;
  readonly csrfName: string;
  readonly profile: CookieProfile;
  readonly path: string;
  /** Sets the session cookie *and* the CSRF cookie derived from the same token. */
  setSession(reply: FastifyReply, token: string, session: SessionRecord): void;
  /** Clears both. */
  clearSession(reply: FastifyReply): void;
  /** Re-stamps `Max-Age` on an already-valid pair, unless the reply already sets one. */
  refreshSession(req: FastifyRequest, reply: FastifyReply, session: SessionRecord): void;
  readSession(req: FastifyRequest): string | null;
  readCsrf(req: FastifyRequest): string | null;
}

export interface CookieJarOptions {
  origin: PublicOrigin;
  basePath: string;
  nodeEnv: string;
  clock?: Clock;
}

export function createCookieJar(opts: CookieJarOptions): CookieJar {
  const profile = cookieProfileFor(opts.origin, opts.nodeEnv);
  const clock = opts.clock ?? systemClock;
  const path = `/${opts.basePath}`;

  const sessionName = `${profile.prefix}${COOKIE_BASE_NAMES.session}`;
  const csrfName = `${profile.prefix}${COOKIE_BASE_NAMES.csrf}`;

  /**
   * - `httpOnly`: script cannot read it, so an XSS that got past the CSP still
   *   cannot exfiltrate the session. The CSRF cookie is the deliberate exception —
   *   a double-submit token the client has to read to echo it back.
   * - `sameSite: 'strict'`: the primary CSRF control. No cross-site request of any
   *   method carries either cookie.
   * - `path`: the base path, so neither cookie is attached to `/healthz`.
   * - **no `domain`**: omitting it makes the cookie host-only. Setting it, even to
   *   the exact host, widens it to every subdomain.
   */
  const attributes = (kind: CookieKind, maxAge: number): CookieAttributes => ({
    httpOnly: kind === 'session',
    secure: profile.secure,
    sameSite: 'strict',
    path,
    maxAge,
  });

  const alreadySetsSessionCookie = (reply: FastifyReply): boolean => {
    const header = reply.getHeader('set-cookie');
    const values = Array.isArray(header) ? header : header === undefined ? [] : [String(header)];
    return values.some((value) => value.startsWith(`${sessionName}=`));
  };

  const read = (req: FastifyRequest, name: string): string | null => {
    const value = req.cookies[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  const setSession = (reply: FastifyReply, token: string, session: SessionRecord): void => {
    const maxAge = cookieMaxAgeSeconds(session, clock.now());
    reply.setCookie(sessionName, token, attributes('session', maxAge));
    // Issued from the same call site as the session cookie, always, so the two
    // cannot drift: whenever the session token rotates, the CSRF token bound to
    // its hash rotates with it, with no separate step to forget.
    reply.setCookie(
      csrfName,
      csrfTokenFor(session.id, hashToken(token)),
      attributes('csrf', maxAge),
    );
  };

  return {
    sessionName,
    csrfName,
    profile,
    path,
    setSession,

    clearSession(reply) {
      const cleared = attributes('session', 0);
      reply.clearCookie(sessionName, cleared);
      reply.clearCookie(csrfName, { ...cleared, httpOnly: false });
    },

    refreshSession(req, reply, session) {
      const token = read(req, sessionName);
      if (token === null) return;
      // A route that rotated the token, or logged out, has already written the
      // authoritative Set-Cookie for this response. Re-stamping here would put the
      // *old* token back and undo the rotation.
      if (alreadySetsSessionCookie(reply)) return;
      setSession(reply, token, session);
    },

    readSession(req) {
      return read(req, sessionName);
    },

    readCsrf(req) {
      return read(req, csrfName);
    },
  };
}
