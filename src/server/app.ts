import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Env } from './env.js';
import { initDb, closeDb } from './db.js';

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

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Panel base path (copy this URL — you will need it):    ║');
  console.log(`║  /${generated}                                              ║`);
  console.log('║                                                         ║');
  console.log('║  This path is persisted in /data/config/instance.json   ║');
  console.log('║  It will NOT be shown again. Set PANEL_BASE_PATH env   ║');
  console.log('║  to override.                                           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

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

  const app = Fastify({
    logger: {
      level: 'info',
      redact: ['password', 'token', 'secret'],
    },
    trustProxy: env.PANEL_TRUST_PROXY,
  });

  // ── Health check (outside base path) ───────────────────────────────────────
  app.get('/healthz', async (_req, reply) => {
    return reply.send({ ok: true });
  });

  // ── Generic 404 for anything outside the base path ─────────────────────────
  app.setNotFoundHandler((_req, reply) => {
    return reply.code(404).header('Content-Type', 'application/json').send({ error: 'Not Found' });
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    await app.close();
    closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return app;
}
