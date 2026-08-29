import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import type { Env } from './env.js';
import { initDb, closeDb } from './db.js';
import { initCrypto, resetCrypto } from './crypto.js';
import securityHeadersPlugin from './plugins/security-headers.js';
import basePathPlugin, { createBasePathGate } from './plugins/base-path.js';
import { createRedactedLogger } from './plugins/logger-redaction.js';

export interface ServerConfig {
  env: Env;
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
  // scrubbed of recognised credential shapes on its way to stdout.
  // Typed as FastifyServerOptions so passing a concrete pino instance does not
  // narrow the instance's logger generic away from FastifyBaseLogger.
  const loggerOptions: FastifyServerOptions = isTestEnv
    ? { logger: false }
    : { loggerInstance: createRedactedLogger() };

  const app = Fastify({
    ...loggerOptions,
    trustProxy: env.PANEL_TRUST_PROXY,
    // Constant-time base path gate. Runs before routing, so a wrong prefix never
    // reaches find-my-way and cannot be brute-forced character by character
    // through the router's traversal timing. See plugins/base-path.ts.
    rewriteUrl: createBasePathGate(basePath),
  });

  // ── Security headers (all routes) ──────────────────────────────────────────
  await app.register(securityHeadersPlugin, { env });

  // ── Health check (outside base path) ───────────────────────────────────────
  app.get('/healthz', async (_req, reply) => {
    return reply.send({ ok: true });
  });

  // ── Base path scoped routes ────────────────────────────────────────────────
  await app.register(basePathPlugin, { basePath });

  // ── Generic error responses ────────────────────────────────────────────────
  // Fastify's default handler puts the thrown Error's message straight into the
  // response body. That is how a credential in an error message — "upstream
  // rejected sk-ant-…" — reaches the client verbatim; the sentinel sweep in
  // tests/integration/secret-leak.test.ts caught exactly that. The real error is
  // logged (through the redacting destination) and the client gets nothing but
  // the status's standard reason phrase.
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
  // Must be byte-identical for all paths: same status, body, headers, timing
  const generic404Body = JSON.stringify({ error: 'Not Found' });
  app.setNotFoundHandler((_req, reply) => {
    return reply
      .code(404)
      .header('Content-Type', 'application/json')
      .send(generic404Body);
  });

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
    done();
  });

  return app;
}
