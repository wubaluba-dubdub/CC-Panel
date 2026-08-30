import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../src/server/app.js';
import { closeDb } from '../../src/server/db.js';
import type { Env } from '../../src/server/env.js';
import type { FastifyInstance } from 'fastify';

export interface TestContext {
  app: FastifyInstance;
  dataDir: string;
  env: Env;
  cleanup: () => Promise<void>;
}

/** Collects everything the server's logger writes, so log lines can be asserted. */
export interface LogCapture {
  readonly target: { write(chunk: string): void };
  /** Every line written so far, joined. */
  text(): string;
  /** Each JSON log line, parsed. Non-JSON lines are skipped. */
  lines(): Record<string, unknown>[];
}

export function createLogCapture(): LogCapture {
  const chunks: string[] = [];
  return {
    target: {
      write(chunk: string): void {
        chunks.push(chunk);
      },
    },
    text: () => chunks.join(''),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export function makeTestEnv(overrides: Partial<Env> = {}): Env {
  const dataDir = mkdtempSync(join(tmpdir(), 'panel-test-'));
  const result: Env = {
    PANEL_MASTER_KEY: Buffer.from('a'.repeat(32)).toString('base64'),
    PANEL_ADMIN_USERNAME: 'admin',
    PANEL_ADMIN_PASSWORD: 'correct-horse-battery-staple',
    PANEL_TRUST_PROXY: true,
    PANEL_DATA_DIR: dataDir,
    PORT: 0,
    NODE_ENV: 'test',
    ...overrides,
  };
  // PANEL_BASE_PATH intentionally omitted by default so base-path generation
  // is exercised. Pass { PANEL_BASE_PATH: 'x' } to pin it.
  return result;
}

export async function createTestServer(
  envOverrides: Partial<Env> = {},
  opts: {
    beforeReady?: (app: FastifyInstance) => void;
    logTarget?: { write(chunk: string): void };
  } = {},
): Promise<TestContext> {
  const env = makeTestEnv(envOverrides);
  const dataDir = env.PANEL_DATA_DIR;

  const app = await buildServer({
    env,
    ...(opts.logTarget ? { logTarget: opts.logTarget } : {}),
  });

  // Routes must be added before the first inject(), which triggers ready().
  // Used to register a deliberately-throwing route so the security-header
  // assertions can cover a 500 as well as a 200 and a 404.
  opts.beforeReady?.(app);

  const cleanup = async (): Promise<void> => {
    await app.close();
    closeDb();
    rmSync(dataDir, { recursive: true, force: true });
  };

  return { app, dataDir, env, cleanup };
}
