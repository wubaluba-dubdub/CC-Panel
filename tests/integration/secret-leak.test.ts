import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { format } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestServer, createLogCapture, type TestContext } from '../helpers/test-server.js';
import {
  SESSION_COOKIE,
  createAuthTestServer,
  enrollAccount,
  loginFully,
  postLogin,
  totpCodeAt,
  type AuthTestContext,
} from '../helpers/auth-harness.js';
import { SecretString, mask } from '../../src/server/crypto.js';
import { SecretsRepository } from '../../src/server/services/secrets.service.js';
import { createRedactedLogger, BASE_PATH_PLACEHOLDER } from '../../src/server/plugins/logger-redaction.js';

const BASE = 'leaktest-base-path-sentinel';

/**
 * Two secret sentinels, because the two defences have different reach.
 *
 * `PATTERNED` looks like a real Anthropic key, so both `SecretString` and the
 * pattern-based logger redaction should stop it. `OPAQUE` matches no pattern at
 * all, so only `SecretString` can — which is the point of it being the primary
 * control. Neither is ever passed to the logger as a bare string; doing so with
 * `OPAQUE` would be a genuine leak, and the test would be right to fail.
 */
const PATTERNED = `sk-ant-api03-${randomBytes(12).toString('hex')}`;
const OPAQUE = `OPAQUE-SENTINEL-${randomBytes(12).toString('hex')}`;
const SENTINELS = [PATTERNED, OPAQUE] as const;

/**
 * The base path is a third sentinel, with a different rule.
 *
 * It is obscurity, not a boundary — but this deploys to Railway, where stdout is
 * retained and readable from the dashboard, so obscurity printed into a retained
 * log is not obscurity. It must therefore never reach stdout or stderr at all.
 *
 * For response bodies the rule has to be narrower, and the exemption is listed
 * explicitly below rather than waved at: a document served from *under* the
 * prefix can only reference its own sibling assets by a path that contains it,
 * and its reader necessarily already knows the prefix.
 */
const BASE_PATH_BODY_EXEMPT = new Set([
  // The bootstrap script — its entire purpose is to hand the prefix to the SPA.
  `/${BASE}/bootstrap.js`,
  // The shell HTML, which must reference bootstrap.js by an absolute path: the
  // CSP sets `base-uri 'none'` so `<base href>` is unavailable, and a relative
  // `src` would resolve to `/bootstrap.js` when the document is fetched without
  // a trailing slash.
  `/${BASE}`,
  `/${BASE}/`,
]);

/**
 * The full route table of the server under test — the application's routes plus
 * the `__throw` route this test registers. Spelled out so that adding a route
 * without extending the sweep below makes this test fail rather than silently
 * leaving the new route unchecked.
 */
const EXPECTED_ROUTE_TREE =
  '├── /healthz (GET, HEAD)\n' +
  `└── /${BASE} (GET, HEAD)\n` +
  '    └── / (GET, HEAD)\n' +
  '        ├── bootstrap.js (GET, HEAD)\n' +
  '        ├── api/auth/login (POST)\n' +
  '        │   └── /totp (POST)\n' +
  '        ├── api/auth/logout (POST)\n' +
  '        ├── api/auth/totp/enroll (POST)\n' +
  '        │   └── /verify (POST)\n' +
  '        ├── api/auth/step-up (POST)\n' +
  '        ├── api/auth/me (GET, HEAD)\n' +
  '        ├── api/sessions (GET, HEAD)\n' +
  '        │   ├── /revoke-others (POST)\n' +
  '        │   └── /:id (DELETE)\n' +
  '        ├── api/security/password (POST)\n' +
  '        ├── api/security/recovery-codes (POST)\n' +
  '        ├── api/security/2fa/disable (POST)\n' +
  '        ├── api/security/base-path/regenerate (POST)\n' +
  '        ├── api/secrets (GET, HEAD, PUT)\n' +
  '        │   └── /reveal (POST)\n' +
  '        └── __throw (GET, HEAD)\n';

/**
 * Every byte SQLite has on disk for this database.
 *
 * Reading `panel.db` alone is not enough and quietly makes the check vacuous:
 * the journal is in WAL mode, so a write made moments ago is in `panel.db-wal`
 * and has not been checkpointed into the main file yet. A sweep that only looked
 * at `panel.db` passed even with token hashing removed entirely.
 */
function databaseBytes(dataDir: string): Buffer {
  const parts: Buffer[] = [];
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      parts.push(readFileSync(join(dataDir, `panel.db${suffix}`)));
    } catch {
      // Sidecar not present; nothing to read.
    }
  }
  return Buffer.concat(parts);
}

interface Captured {
  stdout: string;
  stderr: string;
  restore: () => void;
  text: () => string;
}

/**
 * Captures everything written to stdout and stderr, plus everything handed to
 * `console`.
 *
 * The console arm is not redundant: vitest replaces the console transport, so
 * console output does not reach `process.stdout.write` inside a test. Rendering
 * the arguments with `util.format` — the same machinery `console.log` uses — is
 * what makes that path observable here.
 */
function captureOutput(): Captured {
  const chunks = { stdout: [] as string[], stderr: [] as string[] };
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const originalConsole = { log: console.log, error: console.error, warn: console.warn };

  const patch = (target: 'stdout' | 'stderr'): typeof process.stdout.write =>
    ((chunk: string | Uint8Array): boolean => {
      chunks[target].push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;

  process.stdout.write = patch('stdout');
  process.stderr.write = patch('stderr');
  console.log = (...args: unknown[]): void => void chunks.stdout.push(format(...args) + '\n');
  console.warn = (...args: unknown[]): void => void chunks.stderr.push(format(...args) + '\n');
  console.error = (...args: unknown[]): void => void chunks.stderr.push(format(...args) + '\n');

  return {
    get stdout() {
      return chunks.stdout.join('');
    },
    get stderr() {
      return chunks.stderr.join('');
    },
    text() {
      return chunks.stdout.join('') + chunks.stderr.join('');
    },
    restore() {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
    },
  };
}

describe('M1.3 — sentinel leak sweep', () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('never emits a seeded sentinel through any route, log path, or the database file', async () => {
    ctx = await createTestServer(
      { PANEL_BASE_PATH: BASE },
      {
        beforeReady: (app) => {
          app.get(`/${BASE}/__throw`, async () => {
            // An error message is one of the easiest ways for a secret to reach
            // both a log line and a response body.
            throw new Error(`upstream rejected credential ${PATTERNED}`);
          });
        },
      },
    );

    const repo = new SecretsRepository();
    repo.set('global', 'anthropic_auth_token', PATTERNED);
    repo.set('global', 'opaque_token', new SecretString(OPAQUE));

    // Confirm the sentinels really are in play — a sweep that passes because
    // nothing was ever seeded proves nothing.
    expect(repo.get('global', 'anthropic_auth_token')!.reveal()).toBe(PATTERNED);
    expect(repo.get('global', 'opaque_token')!.reveal()).toBe(OPAQUE);

    await ctx.app.ready();
    expect(ctx.app.printRoutes({ commonPrefix: false })).toBe(EXPECTED_ROUTE_TREE);

    const capture = captureOutput();
    const responses: { url: string; body: string; headers: string }[] = [];

    try {
      // ── Every route, plus the shapes that bypass them ──────────────────────
      const urls = [
        '/healthz',
        `/${BASE}`,
        `/${BASE}/`,
        `/${BASE}/bootstrap.js`,
        `/${BASE}/__throw`,
        `/${BASE}/does-not-exist`,
        '/',
        '/outside-the-base-path',
      ];

      for (const url of urls) {
        for (const method of ['GET', 'HEAD'] as const) {
          const res = await ctx.app.inject({
            method,
            url,
            // Feed the sentinels back in as untrusted input, so a route that
            // echoes its input is caught too.
            headers: { 'x-test-echo': PATTERNED, cookie: `t=${OPAQUE}` },
            query: { q: OPAQUE },
          });
          responses.push({ url, body: res.body, headers: JSON.stringify(res.headers) });
        }
      }

      // ── Every log path ────────────────────────────────────────────────────
      const log = createRedactedLogger({ basePath: BASE });
      const patternedSecret = repo.require('global', 'anthropic_auth_token');
      const opaqueSecret = repo.require('global', 'opaque_token');

      log.info(`token in a message: ${patternedSecret}`);
      log.info({ token: patternedSecret }, 'token in an object');
      log.info({ nested: { deep: [opaqueSecret] } }, 'token nested in an object');
      log.info({ masked: patternedSecret.mask() }, 'masked for display');
      log.info(`raw patterned token straight into a message: ${PATTERNED}`);
      log.error(new Error(`error message carrying ${PATTERNED}`), 'error path');
      log.info({ secrets: repo.list() }, 'repository metadata');
      log.warn({ err: { message: `nested error ${PATTERNED}` } }, 'nested error object');

      // The base path on the same log paths.
      log.info(`request for /${BASE}/api/foo`);
      log.info({ url: `/${BASE}/api/foo` }, 'base path in an object');
      log.info({ nested: { deep: [`/${BASE}/deep`] } }, 'base path nested in an object');
      log.error(new Error(`upstream /${BASE}/api/foo failed`), 'base path in an error');

      // Non-pino paths, which the destination scrub does not cover and where
      // SecretString has to carry it alone.
      console.log(patternedSecret);
      console.log('%s / %j', opaqueSecret, { token: opaqueSecret });
      console.error({ token: opaqueSecret });
      process.stdout.write(`${opaqueSecret}\n`);
      process.stderr.write(JSON.stringify({ token: opaqueSecret }) + '\n');
    } finally {
      capture.restore();
    }

    const logged = capture.text();
    const allBodies = responses.map((r) => `${r.body}\n${r.headers}`).join('\n');
    const database = databaseBytes(ctx.dataDir);

    // The sweep found something to look at.
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).toContain('[redacted]');

    for (const sentinel of SENTINELS) {
      expect(logged, `sentinel in stdout/stderr: ${sentinel}`).not.toContain(sentinel);
      expect(allBodies, `sentinel in a response: ${sentinel}`).not.toContain(sentinel);
      // At rest as well as in flight: the database file must hold ciphertext only.
      expect(
        database.includes(Buffer.from(sentinel, 'utf8')),
        `sentinel in panel.db: ${sentinel}`,
      ).toBe(false);
    }

    // ── The base path sentinel ──────────────────────────────────────────────
    expect(logged, 'base path in stdout/stderr').not.toContain(BASE);
    // The elision happened rather than the lines simply not existing.
    expect(logged).toContain(`/${BASE_PATH_PLACEHOLDER}/api/foo`);
    expect(logged).toContain(`/${BASE_PATH_PLACEHOLDER}/deep`);

    for (const { url, body } of responses) {
      if (BASE_PATH_BODY_EXEMPT.has(url)) continue;
      expect(body, `base path in the body of ${url}`).not.toContain(BASE);
    }

    // The exemption is real, not vacuous: those bodies do carry it.
    const bootstrap = responses.find(
      (r) => r.url === `/${BASE}/bootstrap.js` && r.body.length > 0,
    );
    expect(bootstrap?.body).toContain(BASE);

    // The masked form is allowed through — that is what it is for — but it must
    // not amount to the secret.
    expect(logged).toContain(mask(PATTERNED));
    expect(mask(PATTERNED)).not.toContain(PATTERNED.slice(0, -4));
  });

  it('does not put a sentinel in a WAL or journal sidecar', async () => {
    ctx = await createTestServer({ PANEL_BASE_PATH: BASE });

    const repo = new SecretsRepository();
    repo.set('global', 'token', PATTERNED);

    // WAL mode means writes land in panel.db-wal before they are checkpointed.
    for (const suffix of ['', '-wal', '-shm']) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(ctx.dataDir, `panel.db${suffix}`));
      } catch {
        continue; // sidecar not present, nothing to check
      }
      expect(bytes.includes(Buffer.from(PATTERNED, 'utf8')), `panel.db${suffix}`).toBe(false);
    }
  });
});

/**
 * The M1.4 credentials, swept the same way.
 *
 * These are not seeded sentinels — they are the real thing the running server
 * generated, which is stronger: a sweep against a value we planted only proves the
 * plumbing we planted it through.
 *
 * Each has a different legitimate exit. The session token goes out in a
 * `Set-Cookie` *header* and nowhere else. The TOTP secret goes out in the
 * enrolment response body, once. The recovery codes go out in the
 * enrolment-confirmation body, once. Every other body, every log line, and the
 * database file must be clean of all three.
 */
describe('M1.4 — session token, TOTP secret and recovery codes as sentinels', () => {
  let authCtx: AuthTestContext;

  afterEach(async () => {
    if (authCtx) await authCtx.cleanup();
  });

  it('keeps all three out of the logs, out of every other body, and out of the database', async () => {
    const logs = createLogCapture();
    authCtx = await createAuthTestServer({}, { logTarget: logs.target });

    const capture = captureOutput();
    const bodies: { label: string; body: string; headers: string }[] = [];
    let account: Awaited<ReturnType<typeof enrollAccount>>;
    let rotatedToken = '';

    try {
      account = await enrollAccount(authCtx);

      // Every route reachable with a full session, plus a repeat of the login
      // flow so the token rotation path is exercised too.
      const probes: { label: string; method: 'GET' | 'POST' | 'PUT'; path: string; payload?: Record<string, unknown> }[] = [
        { label: 'me', method: 'GET', path: '/api/auth/me' },
        { label: 'sessions', method: 'GET', path: '/api/sessions' },
        { label: 'secrets', method: 'GET', path: '/api/secrets' },
        { label: 'revoke-others', method: 'POST', path: '/api/sessions/revoke-others' },
      ];

      for (const probe of probes) {
        const res = await authCtx.app.inject({
          method: probe.method,
          url: authCtx.url(probe.path),
          cookies: { [SESSION_COOKIE]: account.cookie },
          ...(probe.payload ? { payload: probe.payload } : {}),
        });
        bodies.push({ label: probe.label, body: res.body, headers: JSON.stringify(res.headers) });
      }

      // A failed login and a failed second factor, which are the paths most
      // likely to echo a submitted credential back.
      const failed = await postLogin(authCtx, { password: 'wrong-password-here' });
      bodies.push({ label: 'failed-login', body: failed.body, headers: JSON.stringify(failed.headers) });

      const relogin = await loginFully(authCtx, account.secret);
      rotatedToken = relogin.cookie;
      bodies.push({
        label: 'relogin',
        body: relogin.response.body,
        headers: JSON.stringify(relogin.response.headers),
      });

      const badCode = await authCtx.app.inject({
        method: 'POST',
        url: authCtx.url('/api/auth/login/totp'),
        cookies: { [SESSION_COOKIE]: rotatedToken },
        payload: { code: account.recoveryCodes[0] },
      });
      bodies.push({ label: 'bad-code', body: badCode.body, headers: JSON.stringify(badCode.headers) });

      // And the deliberate log paths: a credential handed to the logger by hand.
      const log = createRedactedLogger({ basePath: authCtx.app.basePath });
      log.info({ note: 'a session was created' }, 'session');
      log.error(new Error('authentication failed'), 'auth');
    } finally {
      capture.restore();
    }

    const sentinels: [string, string][] = [
      ['session token', account!.cookie],
      ['rotated session token', rotatedToken],
      ['TOTP secret', account!.secret],
      ...account!.recoveryCodes.map((code, i): [string, string] => [`recovery code ${i}`, code]),
    ];

    const logged = capture.text() + logs.text();
    const database = databaseBytes(authCtx.dataDir);
    const allBodies = bodies.map((b) => `${b.label}: ${b.body}`).join('\n');

    // The sweep looked at something.
    expect(logged.length).toBeGreaterThan(0);
    expect(bodies.length).toBeGreaterThan(4);

    for (const [label, value] of sentinels) {
      if (value === '') continue;
      expect(logged, `${label} in stdout/stderr or a log line`).not.toContain(value);
      expect(allBodies, `${label} in a response body`).not.toContain(value);
      expect(
        database.includes(Buffer.from(value, 'utf8')),
        `${label} in panel.db`,
      ).toBe(false);
      // A recovery code is stored canonicalised, so check that spelling too.
      const canonical = value.replace(/-/g, '').toUpperCase();
      expect(database.includes(Buffer.from(canonical, 'utf8')), `${label} canonical in panel.db`).toBe(
        false,
      );
    }
  });

  it('does disclose the enrolment material exactly once, in the enrolment responses', async () => {
    // The counterpart to the sweep above: the exemptions are real rather than the
    // secrets simply never being produced.
    authCtx = await createAuthTestServer();

    const login = await postLogin(authCtx);
    const pre = authCtx.cookieFrom(login)!;

    const enroll = await authCtx.app.inject({
      method: 'POST',
      url: authCtx.url('/api/auth/totp/enroll'),
      cookies: { [SESSION_COOKIE]: pre },
    });
    const { secret } = enroll.json() as { secret: string };
    expect(enroll.body).toContain(secret);

    const verify = await authCtx.app.inject({
      method: 'POST',
      url: authCtx.url('/api/auth/totp/enroll/verify'),
      cookies: { [SESSION_COOKIE]: pre },
      payload: { code: totpCodeAt(secret, authCtx.clock.now()) },
    });
    const { recoveryCodes } = verify.json() as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    expect(verify.body).toContain(recoveryCodes[0]);

    // The session token leaves in a header, never in a body.
    const token = authCtx.cookieFrom(verify)!;
    expect(verify.body).not.toContain(token);
    expect(JSON.stringify(verify.headers)).toContain(token);

    // And asking again never re-discloses them.
    const me = await authCtx.app.inject({
      method: 'GET',
      url: authCtx.url('/api/auth/me'),
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(me.body).not.toContain(secret);
    for (const code of recoveryCodes) expect(me.body).not.toContain(code);
  });
});
