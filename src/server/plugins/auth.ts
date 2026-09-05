import type { FastifyRequest, onRequestAsyncHookHandler, preHandlerAsyncHookHandler } from 'fastify';
import type { AuthLevel, SessionRecord } from '../services/session.service.js';
import type { AuthRuntime } from '../services/auth-runtime.js';
import type { ErrorCode } from '../../shared/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The live session for this request, or null. Set by {@link attachSession}. */
    session: SessionRecord | null;
  }
}

export class HttpError extends Error {
  readonly statusCode: number;
  /**
   * The machine-readable code the client maps to a sentence, or undefined to take the
   * status's default (`app.ts`).
   *
   * The `message` never reaches the client — the error handler replaces it with the status's
   * reason phrase — so this is the *only* thing a caller can say to the browser. Which is why
   * it is a closed union and not a string: see `ErrorCode` in `src/shared/types.ts`.
   */
  readonly code: ErrorCode | undefined;

  constructor(statusCode: number, message: string, code?: ErrorCode) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
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
    const token = runtime.cookies.readSession(req);
    if (token === null) return;
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
      throw new HttpError(401, 'authentication required', 'unauthenticated');
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
      throw new HttpError(401, 'authentication required', 'unauthenticated');
    }
    if (!runtime.sessions.hasStepUp(req.session)) {
      // Safe to be specific: the caller already holds a full session and knows perfectly well
      // whether it has stepped up. Without this the client cannot tell a step-up prompt from
      // any other 403, which is the whole reason the code enum exists.
      throw new HttpError(403, 'step-up re-authentication required', 'step_up_required');
    }
  };
}
