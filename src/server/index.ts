import { loadEnv } from './env.js';
import { buildServer } from './app.js';
import { listenHostFor } from './utils/listen-host.js';
import { assertUnprivileged } from './utils/privileges.js';

/**
 * The production entry point, and the only place these three checks belong.
 *
 * They are here rather than in `buildServer` on purpose: `buildServer` is what the
 * test suite drives, hundreds of times, and two of these are about the *process* —
 * which uid it is, which address it binds — not about the server. A uid assertion
 * inside `buildServer` would also make the suite unrunnable for anyone who happens to
 * be root in a container, which is a bad reason to fail a unit test and a very good
 * reason to refuse to serve.
 */
async function main(): Promise<void> {
  // Before anything is opened or bound. A panel that will later spawn agent
  // processes must not be root, and must not be able to become root again.
  assertUnprivileged();

  const env = loadEnv();
  const listen = listenHostFor(env);

  const app = await buildServer({ env });

  // The one line that makes `PANEL_PUBLIC_URL` visible at boot.
  //
  // That variable is load-bearing in three places at once — the cookie **name**
  // prefix, the `Secure` attribute, and `Origin`/`Host` validation — and a wrong
  // value fails in the most confusing way available: the login round-trip appears to
  // work and the next request is a 401, because the browser dropped a cookie whose
  // name it would not accept over the scheme it saw. So the resolved value, where it
  // came from, and the cookie profile it selected are stated once, at info level,
  // where the operator will see them next to the base-path banner.
  //
  // Safe to log, and that is a deliberate distinction rather than an accident: the
  // public origin is the address the panel answers at and anyone who can reach it
  // already knows it. The **base path** is the secret, and it is not in this line —
  // the redacting destination would elide it anyway.
  app.log.info(
    {
      publicOrigin: app.publicOrigin.origin,
      originSource: app.publicOrigin.source,
      // Which of the two profiles in `plugins/cookies.ts` was selected, plus the
      // resulting cookie name read back from the jar. The name is not spelled here:
      // `tests/integration/cookie-discipline.test.ts` forbids any file but the jar
      // from naming a cookie or a prefix, and it caught this line when it did — which
      // is the better outcome anyway, since the value the jar reports is the one
      // actually on the wire rather than a description of it.
      cookieProfile: app.auth.cookies.profile.secure ? 'secure' : 'development',
      sessionCookie: app.auth.cookies.sessionName,
      listenHost: listen.host,
      listenHostSource: listen.source,
      trustProxy: env.PANEL_TRUST_PROXY,
      nodeEnv: env.NODE_ENV,
    },
    'panel configuration resolved',
  );

  try {
    await app.listen({ port: env.PORT, host: listen.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  // Several of the boot guards already phrase their own messages as `FATAL: …`
  // (public-origin, the cookie profile, the privilege check), because the message is
  // the whole user interface of a refusal to start. Prefixing unconditionally printed
  // `FATAL: FATAL: …` for exactly those.
  const message = err instanceof Error ? err.message : String(err);
  console.error(message.startsWith('FATAL:') ? message : `FATAL: ${message}`);
  process.exit(1);
});
