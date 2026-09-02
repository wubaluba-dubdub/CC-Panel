import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../../src/server/db.js';
import { runPreflight } from '../../src/server/cli/preflight.js';
import { createAuthTestServer, enrollAccount, type AuthTestContext } from '../helpers/auth-harness.js';

/**
 * M1.6 part 4.1 — `npm run preflight`.
 *
 * A command the operator runs before a first deployment and after every change to an
 * environment variable, so that "is this configured correctly" has an answer that is not
 * "read the runbook again and hope".
 *
 * Two properties are asserted harder than the individual checks, because both are the
 * kind of thing that decays silently:
 *
 * - **It prints no secret value.** Every test below sweeps the whole output for the
 *   master key, the admin password and the base path. A length is allowed — it catches a
 *   truncated paste and a variable that never arrived — and nothing else is.
 * - **It changes nothing.** In particular it must not apply migrations, which is what
 *   `initDb()` does as a side effect of opening the database. A preflight that migrated
 *   would be a deployment step disguised as a check.
 */

const KEY = Buffer.from('a'.repeat(32)).toString('base64');
const KEY_B = Buffer.from('b'.repeat(32)).toString('base64');
const PASSWORD = 'correct-horse-battery-staple';
const BASE_PATH = 'a-very-secret-prefix-value';

interface Run {
  exitCode: number;
  text: string;
  /** A line's status by the label it carries. */
  statusOf(label: string): string | undefined;
}

function preflight(env: Record<string, string | undefined>): Run {
  const chunks: string[] = [];
  const { report, exitCode } = runPreflight({
    env: env as NodeJS.ProcessEnv,
    write: (text) => chunks.push(text),
  });
  const text = chunks.join('');
  return {
    exitCode,
    text,
    statusOf: (label) => report.lines.find((l) => l.label === label)?.status,
  };
}

/** A configuration that should pass, apart from whatever a test changes. */
function healthyEnv(dataDir: string): Record<string, string | undefined> {
  return {
    PANEL_MASTER_KEY: KEY,
    PANEL_DATA_DIR: dataDir,
    PANEL_BASE_PATH: BASE_PATH,
    PANEL_PUBLIC_URL: 'https://panel.example.com',
    NODE_ENV: 'production',
    PORT: '8080',
  };
}

/** The one assertion every case makes. */
function revealsNoSecret(run: Run): void {
  expect(run.text).not.toContain(KEY);
  expect(run.text).not.toContain(KEY.slice(0, 12));
  expect(run.text).not.toContain(PASSWORD);
  expect(run.text).not.toContain(BASE_PATH);
}

describe('a healthy configuration', () => {
  let ctx: AuthTestContext | null = null;
  let dataDir: string | null = null;

  afterEach(async () => {
    if (ctx !== null) await ctx.cleanup();
    ctx = null;
    if (dataDir !== null) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  it('passes, and says why each thing passed', async () => {
    ctx = await createAuthTestServer(
      { PANEL_MASTER_KEY: KEY, PANEL_BASE_PATH: BASE_PATH },
      { keepDataDir: true },
    );
    dataDir = ctx.dataDir;
    await enrollAccount(ctx);
    await ctx.cleanup();
    ctx = null;

    // After a first boot the two admin variables should be gone from the environment,
    // which is the state this asserts.
    const run = preflight(healthyEnv(dataDir));

    expect(run.exitCode, run.text).toBe(0);
    expect(run.statusOf('master key decodes to at least 32 bytes')).toBe('pass');
    expect(run.statusOf('public origin resolves')).toBe('pass');
    expect(run.statusOf('cookie profile')).toBe('pass');
    expect(run.statusOf('all migrations are applied')).toBe('pass');
    expect(run.statusOf('audit chain verifies')).toBe('pass');
    expect(run.statusOf('data directory is writable')).toBe('pass');
    expect(run.statusOf('admin credentials')).toBe('pass');
    expect(run.text).toContain('All checks passed');
    revealsNoSecret(run);
  });

  it('describes secrets by length only, and never prints the base path', async () => {
    ctx = await createAuthTestServer(
      { PANEL_MASTER_KEY: KEY, PANEL_BASE_PATH: BASE_PATH },
      { keepDataDir: true },
    );
    dataDir = ctx.dataDir;
    await ctx.cleanup();
    ctx = null;

    const run = preflight({
      ...healthyEnv(dataDir),
      PANEL_ADMIN_USERNAME: 'admin',
      PANEL_ADMIN_PASSWORD: PASSWORD,
    });

    expect(run.text).toContain(`set, ${KEY.length} characters`);
    expect(run.text).toContain(`set, ${PASSWORD.length} characters`);
    // The base path is a secret too — the obscurity layer is worth nothing once it is
    // in a terminal, a shell history and a scrollback buffer.
    expect(run.text).toContain(`set from the environment, ${BASE_PATH.length} characters`);
    revealsNoSecret(run);
  });

  it('does not apply migrations as a side effect of checking them', async () => {
    ctx = await createAuthTestServer(
      { PANEL_MASTER_KEY: KEY, PANEL_BASE_PATH: BASE_PATH },
      { keepDataDir: true },
    );
    dataDir = ctx.dataDir;
    // Roll one migration out of the record, so preflight has something to report. If it
    // opened the database the way `initDb` does, this row would come back — and a
    // preflight that migrated the database would be a deployment step in disguise.
    getDb()
      .prepare('DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)')
      .run();
    const remaining = (getDb().prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }).c;
    await ctx.cleanup();
    ctx = null;

    const run = preflight(healthyEnv(dataDir));
    expect(run.statusOf('all migrations are applied')).toBe('fail');
    expect(run.exitCode).toBe(1);

    // Read back with its own connection, because the point is what is on disk. Still one
    // short: preflight reported, and changed nothing.
    const after = new Database(join(dataDir, 'panel.db'), { readonly: true, fileMustExist: true });
    try {
      expect((after.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }).c).toBe(
        remaining,
      );
    } finally {
      after.close();
    }
  });
});

describe('every failure it exists to catch', () => {
  let dataDir: string | null = null;

  afterEach(() => {
    if (dataDir !== null) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  /** A directory with no database in it: the state before a first deployment. */
  function emptyDir(): string {
    dataDir = mkdtempSync(join(tmpdir(), 'panel-preflight-'));
    return dataDir;
  }

  it('fails with no master key at all', () => {
    const run = preflight({ ...healthyEnv(emptyDir()), PANEL_MASTER_KEY: undefined });
    expect(run.exitCode).toBe(1);
    expect(run.statusOf('master key present')).toBe('fail');
    expect(run.text).toContain('not set');
  });

  it('fails on a truncated master key, which is what a bad paste looks like', () => {
    // base64 decoding never throws in Node; it silently discards what it cannot parse.
    // So the length of the decoded *result* is the only check that means anything.
    const run = preflight({
      ...healthyEnv(emptyDir()),
      PANEL_MASTER_KEY: KEY.slice(0, 20),
    });
    expect(run.exitCode).toBe(1);
    expect(run.statusOf('master key is at least 32 bytes when base64-decoded')).toBe('fail');
    expect(run.text).toContain('truncated paste');
    revealsNoSecret(run);
  });

  it('fails on production with an http public origin', () => {
    const run = preflight({
      ...healthyEnv(emptyDir()),
      PANEL_PUBLIC_URL: 'http://panel.example.com',
    });
    expect(run.exitCode).toBe(1);
    // It fails at `public origin resolves` rather than at the scheme check below it,
    // because `resolvePublicOrigin` refuses this configuration outright — the same
    // refusal the server boots into. Preflight is reporting the *boot* failure, which is
    // the more useful thing to be told.
    expect(run.statusOf('public origin resolves')).toBe('fail');
    expect(run.text).toContain('not https');
    expect(run.text).toContain('Refusing to start');
  });

  it('fails on production with no public origin configured', () => {
    const run = preflight({ ...healthyEnv(emptyDir()), PANEL_PUBLIC_URL: undefined });
    expect(run.exitCode).toBe(1);
    expect(run.statusOf('public origin resolves')).toBe('fail');
    expect(run.text).toContain('PANEL_PUBLIC_URL is required');
  });

  it('warns rather than fails outside production, because that is local development', () => {
    const run = preflight({
      PANEL_MASTER_KEY: KEY,
      PANEL_DATA_DIR: emptyDir(),
      NODE_ENV: 'development',
      PANEL_ADMIN_USERNAME: 'admin',
      PANEL_ADMIN_PASSWORD: PASSWORD,
    });
    expect(run.statusOf('NODE_ENV is production')).toBe('warn');
    expect(run.exitCode).toBe(0);
  });

  it('fails when there is no database and nothing to seed the one user from', () => {
    const run = preflight({ ...healthyEnv(emptyDir()), PANEL_ADMIN_USERNAME: undefined });
    expect(run.exitCode).toBe(1);
    expect(run.statusOf('first boot has credentials to seed the one user from')).toBe('fail');
    expect(run.text).toContain('no way to make one');
  });

  it('passes when there is no database but both admin variables are present', () => {
    const run = preflight({
      ...healthyEnv(emptyDir()),
      PANEL_ADMIN_USERNAME: 'admin',
      PANEL_ADMIN_PASSWORD: PASSWORD,
    });
    expect(run.statusOf('first boot can seed the one user')).toBe('pass');
    expect(run.exitCode).toBe(0);
    revealsNoSecret(run);
  });

  it('fails on a weak or short admin password before it reaches argon2', () => {
    const short = preflight({
      ...healthyEnv(emptyDir()),
      PANEL_ADMIN_USERNAME: 'admin',
      PANEL_ADMIN_PASSWORD: 'short',
    });
    // `loadEnv` rejects it too, which is the point: preflight runs the same validation
    // the server boots through rather than a copy of it.
    expect(short.exitCode).toBe(1);
    expect(short.statusOf('env.ts accepts the environment')).toBe('fail');
  });

  it('warns when the admin password is still set after the user exists', async () => {
    const ctx = await createAuthTestServer(
      { PANEL_MASTER_KEY: KEY, PANEL_BASE_PATH: BASE_PATH },
      { keepDataDir: true },
    );
    dataDir = ctx.dataDir;
    await ctx.cleanup();

    const run = preflight({
      ...healthyEnv(dataDir),
      PANEL_ADMIN_USERNAME: 'admin',
      PANEL_ADMIN_PASSWORD: PASSWORD,
    });
    expect(run.statusOf('admin credentials')).toBe('warn');
    expect(run.text).toContain('does not need to outlive first boot');
    // A warning, not a failure: the panel ignores them and says so at boot too.
    expect(run.exitCode).toBe(0);
    revealsNoSecret(run);
  });

  it('fails when the audit chain does not verify, and separates a wrong key from a tamper', async () => {
    const ctx = await createAuthTestServer(
      { PANEL_MASTER_KEY: KEY, PANEL_BASE_PATH: BASE_PATH },
      { keepDataDir: true },
    );
    dataDir = ctx.dataDir;
    await enrollAccount(ctx);
    await ctx.cleanup();

    // The same database, the wrong key. This is the shape an operator sees after
    // restoring a backup under a different PANEL_MASTER_KEY, and being told so once is
    // what stops the next, real alarm from being dismissed.
    const wrongKey = preflight({ ...healthyEnv(dataDir), PANEL_MASTER_KEY: KEY_B });
    expect(wrongKey.exitCode).toBe(1);
    expect(wrongKey.statusOf('audit chain verifies')).toBe('fail');
    expect(wrongKey.text).toContain('wrong PANEL_MASTER_KEY');
    expect(wrongKey.text).toContain('Key rotation');
    expect(wrongKey.text).not.toContain(KEY_B);

    // And the right key on the same file passes, which is what makes the above a key
    // problem rather than a corruption problem.
    expect(preflight(healthyEnv(dataDir)).statusOf('audit chain verifies')).toBe('pass');
  });

  it('fails when the data directory cannot be written', () => {
    // A read-only parent, which is what a mis-set volume mount looks like from inside
    // the container. Deliberately not a path under /proc: `mkdirSync` there does not
    // fail quickly on WSL2, it hangs, and a check that hangs is worse than one that is
    // wrong.
    const parent = mkdtempSync(join(tmpdir(), 'panel-readonly-'));
    dataDir = parent;
    chmodSync(parent, 0o555);
    try {
      const run = preflight({
        ...healthyEnv(join(parent, 'panel')),
        PANEL_ADMIN_USERNAME: 'admin',
        PANEL_ADMIN_PASSWORD: PASSWORD,
      });
      expect(run.exitCode).toBe(1);
      expect(run.statusOf('data directory is writable')).toBe('fail');
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  it('warns about PANEL_TRUST_PROXY being off, with the reason', () => {
    const run = preflight({
      ...healthyEnv(emptyDir()),
      PANEL_ADMIN_USERNAME: 'admin',
      PANEL_ADMIN_PASSWORD: PASSWORD,
      PANEL_TRUST_PROXY: 'false',
    });
    expect(run.statusOf('PANEL_TRUST_PROXY is on')).toBe('warn');
    expect(run.text).toContain('scheme-downgrade check');
  });
});
