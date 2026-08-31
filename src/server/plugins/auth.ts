import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler, preHandlerAsyncHookHandler } from 'fastify';
import {
  SESSION_COOKIE,
  type AuthLevel,
  type SessionRecord,
} from '../services/session.service.js';
import type { AuthRuntime } from '../services/auth-runtime.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The live session for this request, or null. Set by {@link attachSession}. */
    session: SessionRecord | null;
  }
}

export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

/**
 * Cookie attributes.
 *
 * - `httpOnly`: script cannot read it, so an XSS that gets past the CSP still
 *   cannot exfiltrate the session.
 * - `secure`: set in development too. Modern browsers treat `http://localhost` as
 *   a secure context, so this costs nothing there, and the `__Secure-` name
 *   prefix requires it — a browser will refuse the cookie outright rather than
 *   silently accept an insecure one, which is the failure mode we want.
 * - `sameSite: 'strict'`: the primary CSRF control. No cross-site request, of any
 *   method, carries this cookie.
 * - `path`: scoped to the base path, so the cookie is not sent to `/healthz`.
 * - **no `domain`**: omitting it makes the cookie host-only. Setting it, even to
 *   the exact host, would widen it to every subdomain.
 */
export function sessionCookieOptions(basePath: string): {
  httpOnly: true;
  secure: true;
  sameSite: 'strict';
  path: string;
} {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: `/${basePath}`,
  };
}

export function setSessionCookie(reply: FastifyReply, token: string, basePath: string): void {
  // No maxAge / expires: a session cookie, gone when the browser closes. The
  // server-side row is what actually bounds the lifetime, and it is the only
  // bound that an attacker holding a stolen cookie cannot extend.
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(basePath));
}

export function clearSessionCookie(reply: FastifyReply, basePath: string): void {
  reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(basePath));
}

/**
 * Resolves the cookie into `request.session` for every request in the scope.
 *
 * Runs as `onRequest` so it is in place before any route's own `preHandler`, and
 * never rejects: a request with no session, or an expired one, simply gets
 * `session === null` and it is the route's guard that decides whether that
 * matters. Sliding the idle deadline is a side effect of `resolve()`.
 */
export function attachSession(runtime: AuthRuntime): onRequestAsyncHookHandler {
  return async function attachSessionHook(req: FastifyRequest): Promise<void> {
    req.session = null;
    const token = req.cookies[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length === 0) return;
    req.session = runtime.sessions.resolve(token);
  };
}

/**
 * Rejects a request whose session is not at one of `levels`.
 *
 * 401 for every rejection, with the same generic body, whether the cookie was
 * absent, expired, or merely at the wrong level. A 'pre' session hitting a
 * full-only route learns nothing from the status code.
 */
export function requireLevel(...levels: AuthLevel[]): preHandlerAsyncHookHandler {
  const allowed = new Set(levels);
  return async function requireLevelHook(req: FastifyRequest): Promise<void> {
    if (req.session === null || !allowed.has(req.session.authLevel)) {
      throw new HttpError(401, 'authentication required');
    }
  };
}

/** A fully authenticated session. The default for everything but the login flow. */
export const requireFullSession = requireLevel('full');

/**
 * Requires a full session *and* a step-up granted within the last five minutes.
 *
 * 403 rather than 401, because the distinction is actionable: the client is
 * authenticated and needs to re-authenticate, not log in. That is not a leak — the
 * caller already holds a valid session and knows perfectly well whether it has
 * stepped up.
 */
export function requireStepUp(runtime: AuthRuntime): preHandlerAsyncHookHandler {
  return async function requireStepUpHook(req: FastifyRequest): Promise<void> {
    if (req.session === null || req.session.authLevel !== 'full') {
      throw new HttpError(401, 'authentication required');
    }
    if (!runtime.sessions.hasStepUp(req.session)) {
      throw new HttpError(403, 'step-up re-authentication required');
    }
  };
}
