import type { FastifyInstance } from 'fastify';
import { requireFullSession } from '../plugins/auth.js';
import type { AuthRuntime } from '../services/auth-runtime.js';
import { localeBody, parseBody } from '../utils/zod-schemas.js';
import type { LocaleResponse } from '../../shared/types.js';

/**
 * The interface settings the client may write. One, so far.
 *
 * **A full session, and no step-up.** The language is not a security control and demanding a
 * fresh code to change it would be theatre; but it is a write to the `users` row, so a `pre`
 * session — one factor, mid-login — must not be able to make it. The language toggle on the
 * login screen therefore works entirely client-side, storing the choice in `localStorage`
 * where `bootstrap.js` reads it on the next load. That is the right split: an
 * unauthenticated visitor can change what *their browser* shows and cannot change what the
 * panel stores.
 *
 * **No audit row.** Every other write in the panel gets one, and this deliberately does not:
 * the audit log records what an attacker could do with a stolen session, and "the interface
 * language changed" is neither a privilege change nor a disclosure. A row per language toggle
 * would be noise in the one log that has to stay readable — and the log is capped, so noise
 * there costs the oldest real row.
 */
export default async function settingsRoutes(
  app: FastifyInstance,
  opts: { runtime: AuthRuntime },
): Promise<void> {
  const { runtime } = opts;

  app.patch('/api/settings/locale', { preHandler: requireFullSession }, async (req) => {
    const { locale } = parseBody(localeBody, req.body);
    runtime.users.setLocale(locale);
    const response: LocaleResponse = { locale };
    return response;
  });
}
