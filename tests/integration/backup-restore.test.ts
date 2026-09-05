import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCrypto } from '../../src/server/crypto.js';
import { backupDatabase } from '../../src/server/cli/backup.js';
import { restoreDatabase } from '../../src/server/cli/restore.js';
import { inspectDatabase } from '../../src/server/cli/db-file.js';
import { AuditEvent } from '../../src/server/services/audit.service.js';
import {
  createAuthTestServer,
  enrollAccount,
  postLogin,
  type AuthTestContext,
} from '../helpers/auth-harness.js';

/**
 * M1.6 part 4.3 — backup and restore, driven as a real round trip.
 *
 * `cp panel.db somewhere` is unsafe in WAL mode and quietly so, which is the whole
 * reason these commands exist: a committed row lives in `panel.db-wal` until a
 * checkpoint folds it in, so the main file on its own is an *older* database than the
 * one being served. The first test below measures that rather than asserting it, because
 * "the naive copy is wrong" is the claim the online backup API is here to fix and it
 * should be visible.
 *
 * The refusal is the other half. `restore` will not overwrite a database whose audit
 * chain currently verifies, because a verifying chain is positive evidence that the live
 * database is intact and a restore over it destroys append-only history that nothing can
 * recover.
 */

const KEY_A = Buffer.from('a'.repeat(32)).toString('base64');
const KEY_B = Buffer.from('b'.repeat(32)).toString('base64');

/** Somewhere to put snapshots that is not the data directory being restored into. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'panel-backup-'));
}

function auditRows(path: string): number {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }).c;
  } finally {
    db.close();
  }
}

/** Silences the reports, and returns what they said so a failure can print it. */
function collector(): { write: (text: string) => void; text: () => string } {
  const chunks: string[] = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join('') };
}

describe('a plain file copy is not a backup, and the API is', () => {
  let ctx: AuthTestContext | null = null;
  let dir: string | null = null;

  afterEach(async () => {
    if (ctx !== null) await ctx.cleanup();
    ctx = null;
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('captures rows a cp of panel.db alone would miss', async () => {
    ctx = await createAuthTestServer({ PANEL_MASTER_KEY: KEY_A });
    await enrollAccount(ctx);
    dir = scratch();

    const live = join(ctx.dataDir, 'panel.db');
    const liveRows = auditRows(live);
    expect(liveRows).toBeGreaterThan(0);

    // The WAL is where those rows are. This is the evidence that the hazard is real
    // rather than theoretical on this configuration.
    const wal = `${live}-wal`;
    expect(existsSync(wal), 'the database is not in WAL mode').toBe(true);
    expect(statSync(wal).size).toBeGreaterThan(0);

    // The naive copy. Either it has fewer rows than the live database, or it is not a
    // usable panel database at all — both are the same finding, and which one it is
    // depends on whether a checkpoint has happened yet.
    const naive = join(dir, 'naive.db');
    copyFileSync(live, naive);
    let naiveRows: number | 'unreadable';
    try {
      naiveRows = auditRows(naive);
    } catch {
      naiveRows = 'unreadable';
    }
    if (naiveRows !== 'unreadable') {
      expect(naiveRows, 'a plain copy of panel.db saw every row, so this test proves nothing here').toBeLessThan(liveRows);
    }

    // And the online backup API, which folds the WAL in.
    const report = collector();
    const snapshot = join(dir, 'snapshot.db');
    const result = await backupDatabase({
      source: live,
      destination: snapshot,
      masterKey: KEY_A,
      write: report.write,
    });
    expect(result.exitCode, report.text()).toBe(0);
    expect(auditRows(snapshot)).toBe(liveRows);
  });
});

describe('backup', () => {
  let ctx: AuthTestContext | null = null;
  let dir: string | null = null;

  afterEach(async () => {
    if (ctx !== null) await ctx.cleanup();
    ctx = null;
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('verifies the snapshot it wrote, rather than trusting the copy', async () => {
    ctx = await createAuthTestServer({ PANEL_MASTER_KEY: KEY_A });
    await enrollAccount(ctx);
    dir = scratch();

    const report = collector();
    const snapshot = join(dir, 'snapshot.db');
    const result = await backupDatabase({
      source: join(ctx.dataDir, 'panel.db'),
      destination: snapshot,
      masterKey: KEY_A,
      write: report.write,
    });

    expect(result.exitCode, report.text()).toBe(0);
    expect(report.text()).toContain('integrity_check: ok');
    expect(report.text()).toContain('audit chain verifies');
    expect(result.bytes).toBeGreaterThan(0);
    // And it says the thing the operator has to act on.
    expect(report.text()).toContain('Store these two apart');
  });

  it('refuses to overwrite an existing snapshot without --force', async () => {
    ctx = await createAuthTestServer({ PANEL_MASTER_KEY: KEY_A });
    await enrollAccount(ctx);
    dir = scratch();
    const snapshot = join(dir, 'snapshot.db');
    const source = join(ctx.dataDir, 'panel.db');

    const first = await backupDatabase({ source, destination: snapshot, masterKey: KEY_A, write: () => {} });
    expect(first.exitCode).toBe(0);

    const report = collector();
    const second = await backupDatabase({
      source,
      destination: snapshot,
      masterKey: KEY_A,
      write: report.write,
    });
    // The reason matters: one bad snapshot silently destroying the last good one is the
    // failure this refusal exists for.
    expect(second.exitCode).toBe(1);
    expect(report.text()).toContain('already exists');

    const forced = await backupDatabase({
      source,
      destination: snapshot,
      force: true,
      masterKey: KEY_A,
      write: () => {},
    });
    expect(forced.exitCode).toBe(0);
  });

  it('refuses to back a database up onto itself', async () => {
    ctx = await createAuthTestServer({ PANEL_MASTER_KEY: KEY_A });
    dir = scratch();
    const source = join(ctx.dataDir, 'panel.db');
    const report = collector();
    const result = await backupDatabase({
      source,
      destination: source,
      masterKey: KEY_A,
      write: report.write,
    });
    expect(result.exitCode).toBe(1);
    expect(report.text()).toContain('onto itself');
  });
});

describe('the round trip', () => {
  let ctx: AuthTestContext | null = null;
  let dir: string | null = null;
  let dataDir: string | null = null;

  afterEach(async () => {
    if (ctx !== null) await ctx.cleanup();
    ctx = null;
    for (const path of [dir, dataDir]) {
      if (path !== null) rmSync(path, { recursive: true, force: true });
    }
    dir = null;
    dataDir = null;
  });

  it('backs up, diverges, refuses, forces, restores, and comes back', async () => {
    dir = scratch();
    const snapshot = join(dir, 'snapshot.db');

    // ── 1. a state worth keeping ────────────────────────────────────────────
    let first = await createAuthTestServer({ PANEL_MASTER_KEY: KEY_A }, { keepDataDir: true });
    dataDir = first.dataDir;
    const target = join(dataDir, 'panel.db');
    await enrollAccount(first);
    const rowsAtBackup = auditRows(target);
    expect(first.app.auth.audit.verify().ok).toBe(true);

    const backupReport = collector();
    expect(
      (
        await backupDatabase({
          source: target,
          destination: snapshot,
          masterKey: KEY_A,
          write: backupReport.write,
        })
      ).exitCode,
      backupReport.text(),
    ).toBe(0);
    expect(auditRows(snapshot)).toBe(rowsAtBackup);

    // ── 2. the database moves on ────────────────────────────────────────────
    for (let i = 0; i < 3; i += 1) await postLogin(first, { password: 'wrong-password-entirely' });
    first.app.auth.audit.write({ event: AuditEvent.SessionCreated, outcome: 'success' });
    const rowsAfter = auditRows(target);
    expect(rowsAfter).toBeGreaterThan(rowsAtBackup);
    expect(first.app.auth.audit.verify().ok).toBe(true);

    // The server has to be closed: a restore replaces the file underneath whoever holds
    // it open, and the CLI refuses if anything holds a write lock.
    await first.cleanup();

    // ── 3. the refusal ──────────────────────────────────────────────────────
    const refused = collector();
    const refusal = await restoreDatabase({
      source: snapshot,
      target,
      masterKey: KEY_A,
      write: refused.write,
    });
    expect(refusal.exitCode).toBe(1);
    expect(refusal.restored).toBe(false);
    expect(refused.text()).toContain('its audit chain verifies');
    // And it changed nothing.
    expect(auditRows(target)).toBe(rowsAfter);

    // ── 4. forced, with a safety copy ───────────────────────────────────────
    const forced = collector();
    const restore = await restoreDatabase({
      source: snapshot,
      target,
      force: true,
      masterKey: KEY_A,
      write: forced.write,
      timestamp: '2026-09-02T00:00:00.000Z',
    });
    expect(restore.exitCode, forced.text()).toBe(0);
    expect(restore.restored).toBe(true);
    expect(restore.safetyCopy).not.toBeNull();
    expect(existsSync(restore.safetyCopy!)).toBe(true);
    // The state being replaced was preserved as a consistent database, not a raw copy.
    expect(auditRows(restore.safetyCopy!)).toBe(rowsAfter);

    // ── 5. what landed ─────────────────────────────────────────────────────
    expect(auditRows(target)).toBe(rowsAtBackup);
    // The stale WAL from the database that used to be here is gone. It cannot be
    // asserted as "no -wal exists": the restore's own verification pass opens the
    // restored file, and a WAL-mode database legitimately grows an empty sidecar the
    // moment anything opens it. What must not survive is *content* belonging to the
    // previous database, so the report is the record that it was removed and the size is
    // the record that whatever is there now is fresh.
    expect(forced.text()).toContain('stale WAL sidecar removed');
    for (const sidecar of [`${target}-wal`]) {
      if (existsSync(sidecar)) expect(statSync(sidecar).size, sidecar).toBe(0);
    }
    initCrypto(KEY_A);
    const landed = inspectDatabase(target, KEY_A);
    expect(landed.integrity).toBe('ok');
    expect(landed.chain?.ok).toBe(true);

    // ── 6. and the panel boots on it, with the restored state ───────────────
    ctx = await createAuthTestServer({ PANEL_MASTER_KEY: KEY_A }, { dataDir, keepDataDir: true });
    expect(ctx.app.auth.audit.verify().ok).toBe(true);
    // Logging in still works, so what came back is a usable database and not just a
    // verifiable one: the user row, the argon2 hash and the encrypted TOTP secret all
    // survived the round trip.
    const login = await postLogin(ctx);
    expect(login.statusCode).toBe(200);
    await ctx.cleanup();
    ctx = null;

    // ── 7. the safety copy undoes it ───────────────────────────────────────
    const undo = collector();
    const undone = await restoreDatabase({
      source: restore.safetyCopy!,
      target,
      force: true,
      noSafetyCopy: true,
      masterKey: KEY_A,
      write: undo.write,
    });
    expect(undone.exitCode, undo.text()).toBe(0);
    expect(auditRows(target)).toBe(rowsAfter);
  });
});

describe('restore refuses the things it should', () => {
  let ctx: AuthTestContext | null = null;
  let dir: string | null = null;

  afterEach(async () => {
    if (ctx !== null) await ctx.cleanup();
    ctx = null;
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('refuses a SQLite file that is not a panel database', async () => {
    dir = scratch();
    const foreign = join(dir, 'foreign.db');
    const db = new Database(foreign);
    db.exec('CREATE TABLE unrelated (x TEXT)');
    db.close();

    const report = collector();
    const result = await restoreDatabase({
      source: foreign,
      target: join(dir, 'panel.db'),
      masterKey: KEY_A,
      write: report.write,
    });
    expect(result.exitCode).toBe(1);
    expect(report.text()).toContain('some other SQLite file');
  });

  it('refuses a snapshot written under a different master key, and says which', async () => {
    // The scenario docs/DEPLOY.md warns about, end to end: a snapshot and a key that do
    // not belong together. The chain fails at the snapshot's oldest row, which is the
    // `wrong_key_or_genesis` shape from part 1.2 — and the point of refusing rather than
    // warning is that a key wrong for the log is wrong for the encrypted secrets too,
    // which would only surface later, when something tried to read one.
    dir = scratch();
    const other = await createAuthTestServer({ PANEL_MASTER_KEY: KEY_B }, { keepDataDir: true });
    const otherDir = other.dataDir;
    await enrollAccount(other);
    const snapshot = join(dir, 'from-key-b.db');
    expect(
      (
        await backupDatabase({
          source: join(otherDir, 'panel.db'),
          destination: snapshot,
          masterKey: KEY_B,
          write: () => {},
        })
      ).exitCode,
    ).toBe(0);
    await other.cleanup();
    rmSync(otherDir, { recursive: true, force: true });

    const report = collector();
    const result = await restoreDatabase({
      source: snapshot,
      target: join(dir, 'panel.db'),
      masterKey: KEY_A,
      write: report.write,
    });
    expect(result.exitCode).toBe(1);
    expect(result.restored).toBe(false);
    expect(report.text()).toContain('DIFFERENT PANEL_MASTER_KEY');
    expect(report.text()).toContain('Key rotation');

    // With --force it goes through, because the operator may be restoring a database
    // whose key they are about to supply. The report still says the chain does not
    // verify.
    const forced = collector();
    const forcedResult = await restoreDatabase({
      source: snapshot,
      target: join(dir, 'panel.db'),
      force: true,
      masterKey: KEY_A,
      write: forced.write,
    });
    expect(forcedResult.restored).toBe(true);
    expect(forced.text()).toContain('restoring anyway because --force was given');
    // Restored under the key it was written with, it verifies — which is what makes the
    // refusal above a key problem and not a corruption problem.
    initCrypto(KEY_B);
    expect(inspectDatabase(join(dir, 'panel.db'), KEY_B).chain?.ok).toBe(true);
  });

  it('refuses a missing snapshot', async () => {
    dir = scratch();
    const report = collector();
    const result = await restoreDatabase({
      source: join(dir, 'nope.db'),
      target: join(dir, 'panel.db'),
      masterKey: KEY_A,
      write: report.write,
    });
    expect(result.exitCode).toBe(1);
    expect(report.text()).toContain('the snapshot exists');
  });
});
