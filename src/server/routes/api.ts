import type { FastifyInstance } from 'fastify';
import { attachSession } from '../plugins/auth.js';
import { requireCsrfToken } from '../plugins/csrf.js';
import type { RateLimiter } from '../plugins/rate-limit.js';
import type { AuthRuntime } from '../services/auth-runtime.js';
import type { NotifyService } from '../services/notify.service.js';
import type { ResourceSampler } from '../services/resources.service.js';
import type { Watchdog } from '../services/watchdog.service.js';
import auditRoutes from './audit.js';
import authRoutes from './auth.js';
import metricsRoutes from './metrics.js';
import notificationRoutes from './notifications.js';
import securityRoutes from './security.js';
import settingsRoutes from './settings.js';
import sessionRoutes from './sessions.js';

/**
 * Everything under `/${basePath}/api`.
 *
 * Registered as one encapsulated plugin so the two hooks below apply to the API
 * and nothing else: the shell HTML and `bootstrap.js` have no session to resolve
 * and no body to reject, and running the hooks for them would only add a database
 * read to every asset fetch.
 */
export default async function apiRoutes(
  app: FastifyInstance,
  opts: {
    runtime: AuthRuntime;
    limiter: RateLimiter;
    metrics: ResourceSampler;
    notify: NotifyService;
    watchdog: Watchdog;
  },
): Promise<void> {
  const { runtime, limiter } = opts;

  // Order matters, and each step earns its place before the next one's cost:
  //
  //  1. `attachSession` — one indexed-free scan of the sessions table, and only
  //     when a cookie is actually present. Everything below needs to know whether
  //     there is a session, including which bucket to charge.
  //  2. the rate limiter — before the CSRF HMAC, so a flood of token-less requests
  //     is throttled rather than merely rejected one at a time.
  //  3. the CSRF check — last, because it is the one that needs both the session and
  //     the cookie the client presented.
  //
  // The `Origin` and `Host` check is *not* here: it lives at the root scope in
  // `app.ts` so it also covers the shell, `bootstrap.js` and `/healthz`.
  app.addHook('onRequest', attachSession(runtime));
  app.addHook('onRequest', limiter.sessionAware());
  app.addHook('onRequest', requireCsrfToken(runtime));

  // Keep the client's copy of the cookie on the same schedule as the row.
  //
  // `resolve()` slid the server-side idle deadline during `attachSession`; without
  // this the browser would still be holding the Max-Age issued at login and would
  // discard the cookie eight hours after that, mid-session. `refreshSession`
  // declines to act when the response already carries a session `Set-Cookie`, so a
  // rotation or a logout is never overwritten with the value it just replaced.
  //
  // `req.session ?? null` rather than `req.session !== null`: `onSend` runs on the
  // way out of a request that a *root* hook rejected before `attachSession` ever
  // ran, and there the decorator's value is `undefined`, not null. Reading a cookie
  // at that point threw inside `onSend`, which is too late for the error handler to
  // help — Fastify fell back to its default serialiser and put the internal message
  // in the body of what should have been a bare 403.
  app.addHook('onSend', async (req, reply, payload) => {
    const session = req.session ?? null;
    if (session !== null) runtime.cookies.refreshSession(req, reply, session);
    return payload;
  });

  await app.register(authRoutes, { runtime });
  await app.register(sessionRoutes, { runtime });
  await app.register(securityRoutes, { runtime });
  await app.register(settingsRoutes, { runtime });
  await app.register(auditRoutes, { runtime });
  await app.register(metricsRoutes, { metrics: opts.metrics, watchdog: opts.watchdog });
  await app.register(notificationRoutes, { runtime, notify: opts.notify });
}
