import type { FastifyInstance } from 'fastify';
import { attachSession } from '../plugins/auth.js';
import { requireSameOrigin } from '../plugins/origin-check.js';
import type { AuthRuntime } from '../services/auth-runtime.js';
import authRoutes from './auth.js';
import securityRoutes from './security.js';
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
  opts: { runtime: AuthRuntime },
): Promise<void> {
  const { runtime } = opts;

  // Order matters: reject a cross-origin mutation before spending a database read
  // resolving its cookie.
  app.addHook('onRequest', requireSameOrigin());
  app.addHook('onRequest', attachSession(runtime));

  await app.register(authRoutes, { runtime });
  await app.register(sessionRoutes, { runtime });
  await app.register(securityRoutes, { runtime });
}
