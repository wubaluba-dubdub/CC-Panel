import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { HttpError } from './auth.js';

/** Methods that can change state. `GET` and `HEAD` are excluded by definition. */
const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Strict `Origin` validation on mutating requests.
 *
 * `SameSite=Strict` on the session cookie is the primary CSRF control and is
 * enough on its own for a single-origin application: no cross-site request of any
 * method carries the cookie. This is the second layer, for the cases where that
 * one has historically been weaker than advertised — a browser that has not
 * shipped the current SameSite semantics, or a same-site-but-different-origin
 * document (`http` versus `https` on the same host, another port) which
 * `SameSite` does *not* separate but `Origin` does.
 *
 * A request with **no** `Origin` header is allowed. That is not a hole: browsers
 * attach `Origin` to every cross-origin request and to every same-origin request
 * with a mutating method, so an absent header means a non-browser client — curl,
 * a script — which by definition is not being tricked into acting on someone
 * else's behalf. Rejecting it would break every command-line client for no gain.
 *
 * The self origin is derived from `req.protocol` and `req.host`, both of which
 * respect `trustProxy`, so behind Railway's proxy this compares against the
 * public origin rather than the container's internal one.
 *
 * The double-submit CSRF token that `docs/SECURITY.md` also calls for lands with
 * the client in M2: it needs a non-`HttpOnly` cookie and a header that a browser
 * client sets, and there is no client yet to set it. It is belt to this layer's
 * braces, not a replacement for either control here.
 */
export function requireSameOrigin(): onRequestAsyncHookHandler {
  return async function requireSameOriginHook(req: FastifyRequest): Promise<void> {
    if (!MUTATING_METHODS.has(req.method)) return;

    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin.length === 0) return;

    const expected = `${req.protocol}://${req.host}`;
    if (origin !== expected) {
      throw new HttpError(403, 'cross-origin request rejected');
    }
  };
}
