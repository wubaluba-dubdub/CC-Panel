import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import type { Env } from './env.js';
import { initDb, closeDb } from './db.js';
import { initCrypto, resetCrypto } from './crypto.js';
import securityHeadersPlugin from './plugins/security-headers.js';
import basePathPlugin, { createBasePathGate } from './plugins/base-path.js';
import {
  createOriginAbsenceAuditor,
  createOriginPolicy,
  requireValidOriginAndHost,
} from './plugins/origin-check.js';
import { RateLimiter } from './plugins/rate-limit.js';
import { createRedactedLogger } from './plugins/logger-redaction.js';
import apiRoutes from './routes/api.js';
import healthzRoutes, { createHealthProbe, shippedMigrationCount } from './routes/healthz.js';
import { createAuthRuntime, type AuthRuntime } from './services/auth-runtime.js';
import { ResourceSampler, type StartTimer } from './services/resources.service.js';
import { seedAdminUser } from './services/user.service.js';
import type { Clock, Sleep } from './utils/clock.js';
import { resolvePublicOrigin, type PublicOrigin } from './utils/public-origin.js';

/**
 * Global request body limit.
 *
 * 64 KiB is enormous for an authentication payload and comfortable for the
 * `settings.json` editor in Phase 2. The point is that it is bounded at all: the
 * per-field bounds in `utils/zod-schemas.ts` stop a megabyte reaching argon2, and
 * this stops a megabyte reaching the JSON parser.
 */
export const BODY_LIMIT_BYTES = 64 * 1024;

/**
 * How long a client may take to *deliver* a request.
 *
 * Fastify's `requestTimeout` bounds receipt of the request — headers and body — not
 * the handler, which is what makes it safe to set here at all: the progressive
 * delay pads a failed login by up to thirty seconds inside the handler, and a
 * timeout that counted handler time would cut every slow-path login off at the
 * knees. Thirty seconds is generous for 64 KiB and closes the slow-loris shape
 * where a socket dribbles a byte a minute and holds a connection open for free.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

declare module 'fastify' {
  interface FastifyInstance {
    /** The secret prefix everything is mounted under. */
    basePath: string;
    /** The authentication services, for tests and for later milestones. */
    auth: AuthRuntime;
    /** The configured public origin — the one this panel answers as. */
    publicOrigin: PublicOrigin;
    /** The resource sampler behind `GET /api/metrics`. */
    metrics: ResourceSampler;
  }
}

export interface ServerConfig {
  env: Env;
  /**
   * Test seam. When provided, the redacting logger is installed writing here,
   * even under vitest where logging is otherwise off. Nothing in production
   * passes this.
   */
  logTarget?: { write(chunk: string): void };
  /**
   * Injected time and sleep. The delay schedule tops out at thirty seconds, so
   * the suite drives both rather than waiting. Production uses the real ones.
   */
  clock?: Clock;
  sleep?: Sleep;
  /** One running authentication attempt plus this many queued. Default 1. */
  authQueueLimit?: number;
  /**
   * Test seam. How long one `origin.absent_admitted` row silences the next. The
   * suite sets it to 0 to assert the unthrottled behaviour, and leaves it alone to
   * assert the throttle. Production uses the default in `plugins/origin-check.ts`.
   */
  originAbsenceThrottleMs?: number;
  /**
   * Token-bucket sizes. Test seam only: the suite shrinks a bucket to three tokens
   * so it can empty one in three requests instead of sixty. Production uses the
   * defaults in `plugins/rate-limit.ts`.
   */
  rateLimit?: {
    anonymous?: { capacity: number; refillPerSecond: number };
    session?: { capacity: number; refillPerSecond: number };
  };
  /**
   * Test seams for the resource sampler: a fixture directory to read cgroup files
   * from, and a timer the suite drives by hand instead of waiting a second per tick.
   * Production passes none of it and reads `/sys/fs/cgroup`.
   */
  metrics?: {
    cgroupRoot?: string;
    cadenceMs?: number;
    idleMs?: number;
    startTimer?: StartTimer;
  };
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function ensureDataLayout(dataDir: string): void {
  ensureDir(dataDir);
  ensureDir(join(dataDir, 'home'));
  ensureDir(join(dataDir, 'config'));
  ensureDir(join(dataDir, 'global', 'claude-home'));
  ensureDir(join(dataDir, 'projects'));
  ensureDir(join(dataDir, 'logs'));
  // Created now, used in M2.4. The export feature is not built, but the directory has
  // to be *owned* correctly, and the entrypoint's ownership pass runs from an explicit
  // list — so a directory added here later than the list is a root-owned directory on a
  // live volume that the panel cannot write. `incoming/` is where a partial import
  // lands; it is swept at boot, which is why it is a separate directory rather than a
  // filename convention inside `exports/`.
  ensureDir(join(dataDir, 'exports'));
  ensureDir(join(dataDir, 'exports', 'incoming'));
}

export function checkDataWritable(dataDir: string): void {
  const testFile = join(dataDir, '.boot-check');
  try {
    writeFileSync(testFile, 'ok');
    unlinkSync(testFile);
  } catch {
    throw new Error(`FATAL: data directory is not writable at ${dataDir}`);
  }
}

export function resolveBasePath(env: Env): string {
  const dataDir = env.PANEL_DATA_DIR;
  if (env.PANEL_BASE_PATH) return env.PANEL_BASE_PATH;

  const configDir = join(dataDir, 'config');
  const instanceFile = join(configDir, 'instance.json');
  if (existsSync(instanceFile)) {
    const data = JSON.parse(readFileSync(instanceFile, 'utf-8'));
    if (data.basePath) return data.basePath as string;
  }

  const generated = randomBytes(16)
    .toString('base64url')
    .slice(0, 22);

  ensureDir(configDir);
  writeFileSync(
    instanceFile,
    JSON.stringify({
      basePath: generated,
      installId: randomBytes(16).toString('hex'),
      schemaVersion: 1,
    }),
  );

  // Only show banner if not in test environment
  if (env.NODE_ENV !== 'test') {
    const resolvedInstancePath = resolve(join(dataDir, 'config', 'instance.json'));
    const lines = [
      'Panel base path (copy this URL — you will need it):',
      `/${generated}`,
      '',
      `This path is persisted in ${resolvedInstancePath}`,
      'It will NOT be shown again. Set PANEL_BASE_PATH env',
      'to override.',
    ];
    const maxWidth = Math.max(...lines.map((l) => l.length));
    const border = '═'.repeat(maxWidth + 4);

    console.log('');
    console.log(`╔${border}╗`);
    lines.forEach((line) => {
      const padding = ' '.repeat(maxWidth - line.length);
      console.log(`║  ${line}${padding}  ║`);
    });
    console.log(`╚${border}╝`);
    console.log('');
  }

  return generated;
}

export async function buildServer(config: ServerConfig): Promise<FastifyInstance> {
  const { env } = config;
  const dataDir = env.PANEL_DATA_DIR;

  ensureDataLayout(dataDir);
  checkDataWritable(dataDir);

  // Resolved here, before anything is opened, because two of its outcomes are
  // fatal: a production deployment with no configured public URL, and a production
  // deployment whose public URL is not https. Both would otherwise surface as a
  // session cookie the browser quietly refuses, or one sent in the clear.
  const origin = resolvePublicOrigin(env);

  // Production guard
  if (env.NODE_ENV !== 'production' && process.env.PANEL_REQUIRE_PROD === '1') {
    throw new Error('NODE_ENV must be "production" when PANEL_REQUIRE_PROD=1');
  }

  const basePath = resolveBasePath(env);
  const dbPath = join(dataDir, 'panel.db');
  initDb(dbPath);
  initCrypto(env.PANEL_MASTER_KEY);

  // Disable logger in test environments (including when NODE_ENV=production in tests)
  const isTestEnv = env.NODE_ENV === 'test' || typeof process.env.VITEST !== 'undefined';

  // Second line of defence behind SecretString: every serialised log line is
  // scrubbed of recognised credential shapes on its way to stdout. The same
  // destination also elides the secret base path, and the pino serialisers
  // handed in with `basePath` replace Fastify's `req` serialiser so `req.url`
  // never reaches a log line with the real prefix in it.
  // Typed as FastifyServerOptions so passing a concrete pino instance does not
  // narrow the instance's logger generic away from FastifyBaseLogger.
  const loggerOptions: FastifyServerOptions =
    config.logTarget !== undefined
      ? { loggerInstance: createRedactedLogger({ basePath, target: config.logTarget }) }
      : isTestEnv
        ? { logger: false }
        : { loggerInstance: createRedactedLogger({ basePath }) };

  const app = Fastify({
    ...loggerOptions,
    trustProxy: env.PANEL_TRUST_PROXY,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    // Constant-time base path gate. Runs before routing, so a wrong prefix never
    // reaches find-my-way and cannot be brute-forced character by character
    // through the router's traversal timing. See plugins/base-path.ts.
    rewriteUrl: createBasePathGate(basePath),
  });

  // ── Authentication services ────────────────────────────────────────────────
  const runtime = createAuthRuntime({
    env,
    basePath,
    origin,
    ...(config.clock ? { clock: config.clock } : {}),
    ...(config.sleep ? { sleep: config.sleep } : {}),
    ...(config.authQueueLimit !== undefined ? { queueLimit: config.authQueueLimit } : {}),
  });

  // Reads four small files under /sys/fs/cgroup and one statfs, and only while
  // something is actually polling `GET /api/metrics` — see the class comment for why
  // it is neither computed per request nor kept on a permanent timer.
  const metrics = new ResourceSampler({
    dataDir,
    clock: runtime.clock,
    ...(config.metrics ?? {}),
  });

  app.decorate('basePath', basePath);
  app.decorate('auth', runtime);
  app.decorate('publicOrigin', origin);
  app.decorate('metrics', metrics);

  // Chain any audit row written before migration 008 existed, so `verify()` fails
  // only for tampering and not for history. No-op on every boot after the first.
  runtime.audit.initChain();

  const limiter = new RateLimiter({
    basePath,
    clock: runtime.clock,
    ...(config.rateLimit?.anonymous ? { anonymous: config.rateLimit.anonymous } : {}),
    ...(config.rateLimit?.session ? { session: config.rateLimit.session } : {}),
  });

  // Before the server listens, so the first unknown-username login is not
  // measurably slower than the ones after it.
  await runtime.users.initDummyHash();

  // First boot seeds the one user; every boot after that only nags about the
  // password still being in the environment. Throws if there is no user and no
  // credentials to make one from — a panel nobody can log into is not a
  // recoverable state, so it fails at boot rather than at first login.
  await seedAdminUser({
    users: runtime.users,
    username: env.PANEL_ADMIN_USERNAME,
    password: env.PANEL_ADMIN_PASSWORD,
    warn: (message) => {
      if (isTestEnv) return;
      app.log.warn(message);
    },
    info: (message) => {
      if (isTestEnv) return;
      app.log.info(message);
    },
  });

  // ── Generic error responses ────────────────────────────────────────────────
  //
  // Registered *before* any `register()` call, and that ordering is load-bearing:
  // a child encapsulation context inherits the error handler its parent had at the
  // moment the child was created. Setting this after the routes were registered
  // left every route under `/api` on Fastify's default handler, which puts the
  // thrown Error's `message` straight into the response body — so `throw new
  // HttpError(401, 'invalid credentials')` was answering with the string
  // "invalid credentials" instead of the reason phrase.
  //
  // That is the same class of leak the sentinel sweep caught in M1.3: an error
  // message is how a credential reaches a client verbatim. The real error is
  // logged (through the redacting destination) and the client gets nothing but the
  // status's standard reason phrase.
  app.setErrorHandler((err, req, reply) => {
    const declared = (err as { statusCode?: number }).statusCode;
    const status =
      typeof declared === 'number' && declared >= 400 && declared <= 599 ? declared : 500;

    req.log.error({ err }, 'request failed');

    return reply
      .code(status)
      .header('Content-Type', 'application/json')
      .send(JSON.stringify({ error: STATUS_CODES[status] ?? 'Error' }));
  });

  // ── Generic 404 for anything outside the base path ─────────────────────────
  // Must be byte-identical for all paths: same status, body, headers, timing.
  const generic404Body = JSON.stringify({ error: 'Not Found' });
  app.setNotFoundHandler((_req, reply) => {
    return reply
      .code(404)
      .header('Content-Type', 'application/json')
      .send(generic404Body);
  });

  // ── Security headers (all routes) ──────────────────────────────────────────
  await app.register(securityHeadersPlugin, { env });

  // ── Cookies ────────────────────────────────────────────────────────────────
  // Unsigned on purpose: the session token is 256 bits of CSPRNG output looked up
  // by hash server-side, so a signature would add a key to lose and prove nothing
  // the lookup does not already prove.
  await app.register(fastifyCookie);

  // ── Origin and Host validation (every route; /healthz exempts itself) ──────
  //
  // Root scope, and — like the error handler above — *before* the `register()` calls
  // that create the base-path and API contexts, because a child encapsulation
  // context only inherits the hooks its parent had when the child was created.
  // Installed after those, it would cover nothing but the routes declared here.
  //
  // *After* the cookie plugin, deliberately. Root `onRequest` hooks run in
  // registration order, so putting this first meant a rejected request never
  // reached the cookie parser and `req.cookies` was still null when the API's
  // `onSend` hook ran on the way out — which turned a clean 403 into a 500-shaped
  // body carrying an internal error message.
  //
  // The expected origin comes from configuration, never from the request's own
  // `Host` header. See plugins/origin-check.ts.
  //
  // The observer is the M1.6 addition: an admitted state-changing request that
  // carried no `Origin` at all is still admitted — the reasoning for that has not
  // changed — but it is no longer silent. See `createOriginAbsenceAuditor`.
  app.addHook(
    'onRequest',
    requireValidOriginAndHost(
      createOriginPolicy(env, origin),
      createOriginAbsenceAuditor({
        audit: runtime.audit,
        cookies: runtime.cookies,
        clock: runtime.clock,
        ...(config.originAbsenceThrottleMs !== undefined
          ? { throttleMs: config.originAbsenceThrottleMs }
          : {}),
      }),
    ),
  );

  // ── Health check (outside base path) ───────────────────────────────────────
  //
  // Registered here, at the root scope and after the origin hook, so it inherits that
  // hook (which exempts this one path from the `Host` check) and the root error and
  // not-found handlers. Railway decides whether a deployment goes live from this
  // route's answer, so what it does and does not assert is written out in
  // `routes/healthz.ts`.
  await app.register(healthzRoutes, {
    probe: createHealthProbe({ db: runtime.db, expectedMigrations: shippedMigrationCount() }),
  });

  // ── Base path scoped routes ────────────────────────────────────────────────
  await app.register(basePathPlugin, { basePath, rateLimit: limiter.anonymousOnly() });
  await app.register(apiRoutes, { runtime, limiter, metrics, prefix: `/${basePath}` });


  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    await app.close();
    closeDb();
    // Deliberately not in the onClose hook below: a test that builds two servers
    // and closes one must not pull the key out from under the other.
    resetCrypto();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Without this, every server built in a test run leaks two process listeners
  // and Node starts printing MaxListenersExceededWarning at eleven instances.
  app.addHook('onClose', (_instance, done) => {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    // A sampler armed by the last request would otherwise keep ticking against a
    // closed database and a deleted data directory for a minute after every test.
    metrics.stop();
    done();
  });

  return app;
}
