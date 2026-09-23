import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../../src/server/db.js';
import { initCrypto, resetCrypto } from '../../src/server/crypto.js';
import {
  AuditService,
  AuditEvent,
} from '../../src/server/services/audit.service.js';
import { copyDatabase } from '../../src/server/cli/db-file.js';
import { ProjectsRepository } from '../../src/server/services/projects.service.js';

const KEY = randomBytes(32).toString('base64');

let dataDir: string | null = null;
let db: Database.Database | null = null;

afterEach(() => {
  closeDb();
  resetCrypto();
  if (db) {
    db.close();
    db = null;
  }
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
});

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * Reads the SQL content of a migration file.
 */
function readMigration(version: number): string {
  const dir = join(ROOT, 'src', 'server', 'migrations');
  const files = readdirSync(dir).filter((f) => f.startsWith(String(version).padStart(3, '0')));
  if (files.length === 0) throw new Error(`migration ${version} not found`);
  return readFileSync(join(dir, files[0]!), 'utf-8');
}

/**
 * Runs migrations 001 through the specified version, inclusive.
 * Returns the database for direct manipulation.
 */
function runMigrationsThrough(targetVersion: number): Database.Database {
  dataDir = mkdtempSync(join(tmpdir(), 'panel-migration-proof-'));
  const dbPath = join(dataDir, 'test.db');
  const d = new Database(dbPath);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');

  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  for (let v = 1; v <= targetVersion; v++) {
    const sql = readMigration(v);
    const name = readdirSync(join(ROOT, 'src', 'server', 'migrations'))
      .filter((f) => f.startsWith(String(v).padStart(3, '0')))[0]!
      .replace(/^\d+_/, '')
      .replace(/\.sql$/, '');
    d.transaction(() => {
      d.exec(sql);
      d.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(v, name);
    })();
  }

  return d;
}

/** Highest applied schema version, or 0 when schema_migrations is empty. */
function maxVersion(d: Database.Database): number {
  const row = d.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

/** Row counts for the five tables the populated fixture must cover. Counts only — never contents. */
function tableCounts(d: Database.Database): Record<string, number> {
  const count = (table: string): number =>
    (d.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  return {
    users: count('users'),
    sessions: count('sessions'),
    audit_log: count('audit_log'),
    secrets: count('secrets'),
    notification_queue: count('notification_queue'),
  };
}

function hasProjectsTable(d: Database.Database): boolean {
  const row = d
    .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
    .get() as { c: number };
  return row.c > 0;
}

/** Representative non-secret rows in every table the P2 fixture requires. */
function populateCoreRows(d: Database.Database): void {
  d.prepare(
    `INSERT INTO users (id, username, password_hash, created_at, updated_at)
     VALUES (1, 'admin', 'fake-hash', datetime('now'), datetime('now'))`,
  ).run();
  d.prepare(
    `INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at)
     VALUES ('hash1', datetime('now'), datetime('now'), datetime('now', '+8 hours'))`,
  ).run();
  d.prepare(
    `INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at)
     VALUES ('hash2', datetime('now'), datetime('now'), datetime('now', '+8 hours'))`,
  ).run();
  d.prepare(
    `INSERT INTO secrets (scope, name, payload, created_at, updated_at)
     VALUES ('test', 'test_key', 'v1.fakesecret', datetime('now'), datetime('now'))`,
  ).run();
  d.prepare(
    `INSERT INTO notification_queue (created_at, kind, event_json, next_attempt_at)
     VALUES (datetime('now'), 'test', '{}', datetime('now'))`,
  ).run();
}

/** Applies migration 012 and records version 12, the same way the real runner does. */
function applyMigration012(d: Database.Database): void {
  const sql = readMigration(12);
  d.transaction(() => {
    d.exec(sql);
    d.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(12, 'projects');
  })();
}

/**
 * M2.2 — migration 012 applies cleanly to a populated 011 database.
 *
 * This is the first upgrade-proof test in the repository. Every earlier test
 * migrates from zero; this one builds a database at migration 011, populates
 * it with representative rows, applies 012, and verifies that:
 * - the audit chain still verifies,
 * - the append-only triggers still exist,
 * - no existing row was changed,
 * - and the projects table exists with the correct schema.
 */
describe('M2.2 — migration 012 upgrade from 011', () => {
  it('applies to a populated database without breaking the audit chain', () => {
    initCrypto(KEY);

    // 1. Build a database at migration 011 with representative rows.
    db = runMigrationsThrough(11);
    expect(maxVersion(db), 'fixture starts at schema version 11').toBe(11);
    expect(hasProjectsTable(db), 'projects table absent before 012').toBe(false);

    populateCoreRows(db);

    // Populate audit_log through the audit service (to get proper chaining).
    const audit = new AuditService({ db, basePath: 'test-base' });
    audit.write({
      event: AuditEvent.LoginSuccess,
      outcome: 'success',
      meta: { user: 'admin' },
    });
    audit.write({
      event: AuditEvent.LoginFailure,
      outcome: 'failure',
      meta: { reason: 'bad_credentials' },
    });
    audit.write({
      event: AuditEvent.SessionCreated,
      outcome: 'success',
    });

    const beforeVerify = audit.verify();
    expect(beforeVerify.ok).toBe(true);
    const auditCount = beforeVerify.checked;
    expect(auditCount).toBeGreaterThanOrEqual(3);

    // Non-secret row counts before the upgrade. Exact for the four fixed
    // fixtures; audit_log is however many the service chained.
    const countsBefore = tableCounts(db);
    expect(countsBefore).toEqual({
      users: 1,
      sessions: 2,
      audit_log: auditCount,
      secrets: 1,
      notification_queue: 1,
    });

    // Full-row snapshots for equality after the upgrade. Contents are compared
    // in-process only; nothing is logged and no secret value is printed.
    const rowsBefore = {
      users: db.prepare('SELECT * FROM users WHERE id = 1').get(),
      sessions: db.prepare('SELECT * FROM sessions ORDER BY id').all(),
      secrets: db.prepare('SELECT * FROM secrets ORDER BY id').all(),
      auditRows: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      queue: db.prepare('SELECT * FROM notification_queue ORDER BY id').all(),
    };
    const firstAuditId = (rowsBefore.auditRows as { id: number }[])[0]!.id;

    // 2. Apply migration 012.
    applyMigration012(db);
    expect(maxVersion(db), 'fixture advances to schema version 12').toBe(12);

    // 3. Verify: the audit chain still verifies over the same number of rows.
    const afterVerify = audit.verify();
    expect(afterVerify.ok).toBe(true);
    expect(afterVerify.checked).toBe(auditCount);

    // 4. Verify: no existing row changed, in any of the five required tables.
    expect(tableCounts(db)).toEqual(countsBefore);
    expect(db.prepare('SELECT * FROM users WHERE id = 1').get()).toEqual(rowsBefore.users);
    expect(db.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(rowsBefore.sessions);
    expect(db.prepare('SELECT * FROM secrets ORDER BY id').all()).toEqual(rowsBefore.secrets);
    expect(db.prepare('SELECT * FROM audit_log ORDER BY id').all()).toEqual(rowsBefore.auditRows);
    expect(db.prepare('SELECT * FROM notification_queue ORDER BY id').all()).toEqual(
      rowsBefore.queue,
    );

    // 5. Verify: the append-only triggers still exist AND still reject.
    // Names alone would pass with a trigger body that had been gutted.
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'audit_%'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(triggers).toContain('audit_log_no_update');
    expect(triggers).toContain('audit_log_no_delete');
    expect(() =>
      db!.prepare("UPDATE audit_log SET outcome = 'failure' WHERE id = ?").run(firstAuditId),
    ).toThrow(/append-only/);
    expect(() => db!.prepare('DELETE FROM audit_log WHERE id = ?').run(firstAuditId)).toThrow(
      /append-only/,
    );
    // The rejected writes left the row and the chain intact.
    expect(tableCounts(db).audit_log).toBe(auditCount);
    expect(audit.verify().ok).toBe(true);

    // 6. Verify: the projects table exists with the correct schema.
    // slug_normalized is a UNIQUE backstop for ASCII case via SQLite LOWER()
    // only — not NFC and not locale-aware case folding. The repository owns
    // NFC + toLowerCase + the ASCII pattern; this column does not alone
    // enforce the full validation contract.
    expect(hasProjectsTable(db)).toBe(true);

    const columns = db.prepare("PRAGMA table_xinfo(projects)").all() as { name: string }[];
    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('uuid');
    expect(colNames).toContain('slug');
    expect(colNames).toContain('slug_normalized');
    expect(colNames).toContain('isolated_settings');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('updated_at');
    // The seven import columns.
    expect(colNames).toContain('origin');
    expect(colNames).toContain('origin_ref');
    expect(colNames).toContain('origin_at');
    expect(colNames).toContain('source_install_id');
    expect(colNames).toContain('review_state');
    expect(colNames).toContain('reviewed_at');
    expect(colNames).toContain('artefacts_json');

    // 7. Verify: schema_migrations records both 011 and 012.
    const versions = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((r) => (r as { version: number }).version);
    expect(versions).toContain(11);
    expect(versions).toContain(12);
  });

  it('a restored pre-012 snapshot shows version 11 and no projects table', async () => {
    // Not a down-migration: there is none. This preserves an independent
    // pre-upgrade snapshot (through the same online backup API `npm run backup`
    // uses), upgrades a separate working copy to 012, then opens the untouched
    // snapshot to assert what a restore of that snapshot actually contains.
    initCrypto(KEY);

    db = runMigrationsThrough(11);
    populateCoreRows(db);
    const audit = new AuditService({ db, basePath: 'test-base' });
    audit.write({ event: AuditEvent.LoginSuccess, outcome: 'success' });
    audit.write({ event: AuditEvent.SessionCreated, outcome: 'success' });

    const countsBefore = tableCounts(db);
    expect(countsBefore).toEqual({
      users: 1,
      sessions: 2,
      audit_log: 2,
      secrets: 1,
      notification_queue: 1,
    });
    const chainBefore = audit.verify();
    expect(chainBefore.ok).toBe(true);

    // Logical consistent snapshot: the backup API reads through SQLite and
    // writes a standalone database with committed WAL-visible rows folded in.
    // It does NOT copy panel.db-wal or panel.db-shm sidecar files — those
    // remain beside the live database and are not part of the snapshot.
    const snapshotPath = join(dataDir!, 'pre-012-snapshot.db');
    await copyDatabase(join(dataDir!, 'test.db'), snapshotPath);

    // Upgrade the working copy only.
    applyMigration012(db);
    expect(maxVersion(db)).toBe(12);
    expect(hasProjectsTable(db)).toBe(true);

    // The untouched pre-012 snapshot, opened independently of the working copy.
    const snap = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      expect(maxVersion(snap), 'restored pre-012 snapshot highest version').toBe(11);
      expect(hasProjectsTable(snap), 'projects table absent in pre-012 snapshot').toBe(false);
      expect(tableCounts(snap), 'populated counts unchanged in the snapshot').toEqual(countsBefore);
      const snapAudit = new AuditService({ db: snap, basePath: 'test-base' });
      const snapChain = snapAudit.verify();
      expect(snapChain.ok, 'audit chain verifies on the restored snapshot').toBe(true);
      expect(snapChain.checked).toBe(chainBefore.checked);
    } finally {
      snap.close();
    }
  });
});

/**
 * M2.2 — the seven import columns exist and nothing reads or writes them yet.
 *
 * Two complementary proofs:
 * 1. A broad text scan over src/server for the six column names that are unique
 *    to the import feature. `origin` is omitted there because it is a common
 *    word (HTTP Origin handling) and would false-positive — it is covered by
 *    proof 2 instead, in SQL context.
 * 2. A focused assertion over the projects repository's *executable* SQL (every
 *    string passed to `prepare` while the full API runs) plus the row mapper's
 *    output keys, covering all seven identifiers including `origin`.
 *
 * A TypeScript field that names a column is a schema/type declaration, not a
 * runtime read; only a value that arrives from a projection or is written
 * through an INSERT/UPDATE list counts. Proof 2 therefore inspects SQL
 * fragments and returned object keys, not interface declarations.
 */
describe('M2.2 — import columns are declared and unused', () => {
  it('the seven columns exist in the projects table', () => {
    db = runMigrationsThrough(12);
    const columns = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
    const colNames = columns.map((c) => c.name);

    for (const col of [
      'origin',
      'origin_ref',
      'origin_at',
      'source_install_id',
      'review_state',
      'reviewed_at',
      'artefacts_json',
    ]) {
      expect(colNames, `missing column: ${col}`).toContain(col);
    }
  });

  it('no file under src/server reads or writes the import columns', () => {
    // Supplementary word scan for the six unique identifiers. The repository
    // interface is no longer excluded: ProjectRow no longer names the reserved
    // columns, so a hit there would be a real reference, not a type declaration.
    const serverDir = join(ROOT, 'src', 'server');
    const uniqueColumns = [
      'origin_ref',
      'origin_at',
      'source_install_id',
      'review_state',
      'reviewed_at',
      'artefacts_json',
    ];

    const violations: string[] = [];

    function scanDir(dir: string): void {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(path);
        } else if (entry.name.endsWith('.ts')) {
          const content = readFileSync(path, 'utf-8');
          for (const col of uniqueColumns) {
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i]!;
              // Skip comments
              if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
              // Skip PRAGMA table_info/table_xinfo (used in tests)
              if (line.includes('PRAGMA table_')) continue;
              // Check for the column name in a SQL-like context
              if (
                line.includes(`"${col}"`) ||
                line.includes(`'${col}'`) ||
                line.match(new RegExp(`\\b${col}\\b`))
              ) {
                violations.push(`${path}:${i + 1} — ${col}`);
              }
            }
          }
        }
      }
    }

    scanDir(serverDir);

    // Filter out hits from the migration file — it legitimately names these columns.
    const codeHits = violations.filter((v) => !v.includes('migrations/'));

    expect(
      codeHits,
      `import columns referenced in application code: ${codeHits.join(', ')}`,
    ).toEqual([]);
  });

  it('repository executable SQL and row mapper never touch the seven reserved columns', () => {
    db = runMigrationsThrough(12);

    // Capture every string the repository passes to prepare(), then exercise
    // the full API so create/get/list/rename/delete collision paths all run.
    const captured: string[] = [];
    const realPrepare = db.prepare.bind(db);
    Object.defineProperty(db, 'prepare', {
      configurable: true,
      writable: true,
      value: (sql: string) => {
        captured.push(sql);
        return realPrepare(sql);
      },
    });
    const repo = new ProjectsRepository({ db });

    const first = repo.create({ slug: 'sql-proof' });
    repo.create({ slug: 'sql-proof' });
    repo.getByUuid(first.project.uuid);
    repo.getBySlug('SQL-PROOF');
    repo.list();
    repo.rename(first.project.uuid, 'sql-proof-renamed');
    const doomed = repo.create({ slug: 'to-delete' });
    repo.delete(doomed.project.uuid);

    expect(captured.length, 'the API exercise prepared SQL').toBeGreaterThan(0);

    const reserved = [
      'origin',
      'origin_ref',
      'origin_at',
      'source_install_id',
      'review_state',
      'reviewed_at',
      'artefacts_json',
    ] as const;

    /** Fragments where a reserved identifier would be a runtime read or write. */
    function sqlFragments(sql: string): string[] {
      const flat = sql.replace(/\s+/g, ' ').trim();
      const frags: string[] = [];
      const sel = /SELECT\s+([\s\S]+?)\s+FROM\s+/i.exec(flat);
      if (sel) frags.push(sel[1]!);
      const ins = /INSERT\s+INTO\s+[`"]?\w+[`"]?\s*\(([^)]+)\)/i.exec(flat);
      if (ins) frags.push(ins[1]!);
      const upd = /UPDATE\s+[`"]?\w+[`"]?\s+SET\s+([\s\S]+?)\s+WHERE\s+/i.exec(flat);
      if (upd) frags.push(upd[1]!);
      const ret = /RETURNING\s+([\s\S]+)$/i.exec(flat);
      if (ret) frags.push(ret[1]!);
      return frags;
    }

    const violations: string[] = [];
    for (const sql of captured) {
      // SELECT * would silently read every reserved column without naming one.
      if (/\bSELECT\s+\*/i.test(sql)) violations.push(`SELECT * — ${sql}`);
      for (const frag of sqlFragments(sql)) {
        for (const col of reserved) {
          if (new RegExp(`\\b${col}\\b`, 'i').test(frag)) {
            violations.push(`${col} in SQL fragment of — ${sql}`);
          }
        }
      }
    }
    expect(violations, violations.join(' | ')).toEqual([]);

    // Row mapper: ProjectRecord keys are exactly the public shape — no spread
    // of a full row can smuggle a reserved column onto the returned object.
    const record = repo.getByUuid(first.project.uuid)!;
    for (const col of reserved) {
      expect(
        Object.prototype.hasOwnProperty.call(record, col),
        `row mapper exposed reserved column: ${col}`,
      ).toBe(false);
    }
    const listed = repo.list();
    for (const row of listed) {
      for (const col of reserved) {
        expect(Object.prototype.hasOwnProperty.call(row, col)).toBe(false);
      }
    }
  });
});

/**
 * M2.2 — migration 012 is the only new file and versions are contiguous.
 */
describe('M2.2 — migration file integrity', () => {
  it('012_projects.sql is the only new migration file', () => {
    const migrationsDir = join(ROOT, 'src', 'server', 'migrations');
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // All files should be numbered 001 through 012.
    expect(files).toEqual([
      '001_users.sql',
      '002_sessions.sql',
      '003_audit.sql',
      '004_secrets.sql',
      '005_lockout.sql',
      '006_secrets_payload.sql',
      '007_auth.sql',
      '008_audit_integrity.sql',
      '009_notifications.sql',
      '010_watchdog.sql',
      '011_locale_and_clear_window.sql',
      '012_projects.sql',
    ]);
  });

  it('migration versions are contiguous with no duplicates', () => {
    db = runMigrationsThrough(12);
    const versions = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((r) => (r as { version: number }).version);

    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

/**
 * M2.2 — the built artefact contains the new migration.
 */
describe('M2.2 — dist contains 012_projects.sql', () => {
  it('npm run build emits dist/server/migrations/012_projects.sql', () => {
    const emitted = join(ROOT, 'dist', 'server', 'migrations', '012_projects.sql');
    const source = join(ROOT, 'src', 'server', 'migrations', '012_projects.sql');

    // The file must exist in dist and be byte-identical to the source.
    // This is already covered by build.test.ts's "emits every migration" test,
    // but the prompt requires an explicit assertion for the new migration.
    expect(existsSync(emitted), 'dist/server/migrations/012_projects.sql was not emitted').toBe(
      true,
    );
    expect(readFileSync(emitted, 'utf-8')).toBe(readFileSync(source, 'utf-8'));
  });
});
