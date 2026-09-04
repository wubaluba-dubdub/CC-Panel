import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../src/server/app.js';
import { closeDb } from '../../src/server/db.js';
import type { Env } from '../../src/server/env.js';
import type { Clock, Sleep } from '../../src/server/utils/clock.js';
import type { StartTimer } from '../../src/server/services/resources.service.js';
import type { ScheduleTimer } from '../../src/server/services/notify.service.js';
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

/**
 * Env overrides for a test server.
 *
 * A key set explicitly to `undefined` *removes* the default rather than being
 * ignored, which is how a test exercises "no `PANEL_ADMIN_PASSWORD` in the
 * environment" or "no `PANEL_BASE_PATH`, so generate one".
 */
export type EnvOverrides = { [K in keyof Env]?: Env[K] | undefined };

export function makeTestEnv(overrides: EnvOverrides = {}): Env {
  const dataDir = mkdtempSync(join(tmpdir(), 'panel-test-'));
  const result: Env = {
    PANEL_MASTER_KEY: Buffer.from('a'.repeat(32)).toString('base64'),
    PANEL_ADMIN_USERNAME: 'admin',
    PANEL_ADMIN_PASSWORD: 'correct-horse-battery-staple',
    PANEL_TRUST_PROXY: true,
    PANEL_DATA_DIR: dataDir,
    PORT: 0,
    PANEL_NOTIFY_INCLUDE_LINKS: false,
    PANEL_NOTIFY_LOCALE: 'en',
    NODE_ENV: 'test',
  };

  const mutable = result as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete mutable[key];
    else mutable[key] = value;
  }

  // PANEL_BASE_PATH intentionally has no default, so base-path generation is
  // exercised. Pass { PANEL_BASE_PATH: 'x' } to pin it.
  return result;
}

export interface CreateTestServerOptions {
  beforeReady?: (app: FastifyInstance) => void;
  logTarget?: { write(chunk: string): void };
  clock?: Clock;
  sleep?: Sleep;
  authQueueLimit?: number;
  /** How long one `origin.absent_admitted` row silences the next. */
  originAbsenceThrottleMs?: number;
  /**
   * Token-bucket sizes. Shrinking a bucket to a handful of tokens is what lets the
   * rate-limit suite empty one in three requests instead of sixty.
   */
  rateLimit?: {
    anonymous?: { capacity: number; refillPerSecond: number };
    session?: { capacity: number; refillPerSecond: number };
  };
  /**
   * Resource sampler seams: a fixture cgroup directory, and a timer the test drives.
   * Without the fixture directory the sampler reads this machine's `/sys/fs/cgroup`,
   * and the answer differs between a developer's box and CI — which is the one thing a
   * test of these figures must not depend on.
   */
  metrics?: {
    cgroupRoot?: string;
    cadenceMs?: number;
    idleMs?: number;
    startTimer?: StartTimer;
  };
  /**
   * Notification seams: point the Telegram transport at a local fake server, drive the
   * worker by hand, pin the jitter. The suite never talks to Telegram.
   */
  notify?: {
    telegramBaseUrl?: string;
    startTimer?: ScheduleTimer;
    random?: () => number;
    maxAttempts?: number;
    maxPending?: number;
    autoStart?: boolean;
  };
  /** Reuse an existing data directory, to simulate a restart against the same volume. */
  dataDir?: string;
  /** Skip removing the data directory on cleanup, so a restart can reuse it. */
  keepDataDir?: boolean;
}

export async function createTestServer(
  envOverrides: EnvOverrides = {},
  opts: CreateTestServerOptions = {},
): Promise<TestContext> {
  const env = makeTestEnv({
    ...envOverrides,
    ...(opts.dataDir ? { PANEL_DATA_DIR: opts.dataDir } : {}),
  });
  const dataDir = env.PANEL_DATA_DIR;

  const app = await buildServer({
    env,
    ...(opts.logTarget ? { logTarget: opts.logTarget } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.authQueueLimit !== undefined ? { authQueueLimit: opts.authQueueLimit } : {}),
    ...(opts.originAbsenceThrottleMs !== undefined
      ? { originAbsenceThrottleMs: opts.originAbsenceThrottleMs }
      : {}),
    ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    ...(opts.metrics ? { metrics: opts.metrics } : {}),
    ...(opts.notify ? { notify: opts.notify } : {}),
  });

  // Routes must be added before the first inject(), which triggers ready().
  // Used to register a deliberately-throwing route so the security-header
  // assertions can cover a 500 as well as a 200 and a 404.
  opts.beforeReady?.(app);

  const cleanup = async (): Promise<void> => {
    await app.close();
    closeDb();
    if (!opts.keepDataDir) rmSync(dataDir, { recursive: true, force: true });
  };

  return { app, dataDir, env, cleanup };
}
