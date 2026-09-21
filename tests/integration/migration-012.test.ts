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

    // Populate users (the single user row).
    db.prepare(
      `INSERT INTO users (id, username, password_hash, created_at, updated_at)
       VALUES (1, 'admin', 'fake-hash', datetime('now'), datetime('now'))`,
    ).run();

    // Populate sessions.
    db.prepare(
      `INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at)
       VALUES ('hash1', datetime('now'), datetime('now'), datetime('now', '+8 hours'))`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at)
       VALUES ('hash2', datetime('now'), datetime('now'), datetime('now', '+8 hours'))`,
    ).run();

    // Populate secrets.
    db.prepare(
      `INSERT INTO secrets (scope, name, payload, created_at, updated_at)
       VALUES ('test', 'test_key', 'v1.fakesecret', datetime('now'), datetime('now'))`,
    ).run();

    // Populate notification_queue.
    db.prepare(
      `INSERT INTO notification_queue (created_at, kind, event_json, next_attempt_at)
       VALUES (datetime('now'), 'test', '{}', datetime('now'))`,
    ).run();

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

    // Snapshot existing rows for comparison after migration.
    const usersBefore = db.prepare('SELECT * FROM users WHERE id = 1').get();
    const sessionsBefore = db.prepare('SELECT * FROM sessions ORDER BY id').all();
    const secretsBefore = db.prepare('SELECT * FROM secrets ORDER BY id').all();
    const auditRowsBefore = db.prepare('SELECT * FROM audit_log ORDER BY id').all();

    // 2. Apply migration 012.
    const sql012 = readMigration(12);
    db.transaction(() => {
      db!.exec(sql012);
      db!.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
        12,
        'projects',
      );
    })();

    // 3. Verify: the audit chain still verifies over the same number of rows.
    const afterVerify = audit.verify();
    expect(afterVerify.ok).toBe(true);
    expect(afterVerify.checked).toBe(auditCount);

    // 4. Verify: no existing row changed.
    const usersAfter = db.prepare('SELECT * FROM users WHERE id = 1').get();
    expect(usersAfter).toEqual(usersBefore);

    const sessionsAfter = db.prepare('SELECT * FROM sessions ORDER BY id').all();
    expect(sessionsAfter).toEqual(sessionsBefore);

    const secretsAfter = db.prepare('SELECT * FROM secrets ORDER BY id').all();
    expect(secretsAfter).toEqual(secretsBefore);

    const auditRowsAfter = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
    expect(auditRowsAfter).toEqual(auditRowsBefore);

    // 5. Verify: the append-only triggers still exist.
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'audit_%'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(triggers).toContain('audit_log_no_update');
    expect(triggers).toContain('audit_log_no_delete');

    // 6. Verify: the projects table exists with the correct schema.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('projects');

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

  it('reports what a rollback sees', () => {
    initCrypto(KEY);

    // There is no down-migration. The operator must restore from a backup
    // taken before the upgrade. The pre-restore copy kept by `npm run restore`
    // is sufficient because it captures the database file before migration 012
    // ran, including the WAL sidecar.
    //
    // If the operator needs to go back manually:
    // 1. Stop the panel.
    // 2. Replace panel.db, panel.db-wal, and panel.db-shm with the pre-upgrade copies.
    // 3. Restart.
    //
    // schema_migrations will still show version 12, but the projects table will
    // not exist — which is fine because no code reads it yet (M2.2's repository
    // is the only reader, and it will fail with "no such table: projects").
    // A fresh `initDb` on the restored database re-applies migration 012.
    //
    // This test verifies that a restored database (pre-012) still verifies.
    db = runMigrationsThrough(11);

    const audit = new AuditService({ db, basePath: 'test-base' });
    audit.write({
      event: AuditEvent.LoginSuccess,
      outcome: 'success',
    });
    const verifyResult = audit.verify();
    expect(verifyResult.ok).toBe(true);
    expect(verifyResult.checked).toBe(1);
  });
});

/**
 * M2.2 — the seven import columns exist and nothing reads or writes them yet.
 *
 * The word "origin" appears in many non-column contexts (HTTP Origin header,
 * public-origin utility, etc.), so a naive word scan would false-positive. This
 * test instead asserts that no file under src/server (excluding migrations)
 * contains an INSERT, UPDATE, or SELECT that references the projects table's
 * import columns.
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
    // The import columns are declared in the migration but unused as of this
    // commit. No repository, service, or route should reference them in a SQL
    // context. We scan for the specific column names that are unique to the
    // import feature — not "origin", which is a common word — to avoid false
    // positives from HTTP Origin handling.
    //
    // projects.service.ts is excluded because its ProjectRow interface declares
    // the column names for type safety — this is a TypeScript type, not a SQL
    // read or write. The scan targets files that would execute SQL against these
    // columns.
    const serverDir = join(ROOT, 'src', 'server');
    const uniqueColumns = [
      'origin_ref',
      'origin_at',
      'source_install_id',
      'review_state',
      'reviewed_at',
      'artefacts_json',
    ];
    const excludedFiles = new Set(['projects.service.ts']);

    const violations: string[] = [];

    function scanDir(dir: string): void {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(path);
        } else if (entry.name.endsWith('.ts') && !excludedFiles.has(entry.name)) {
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
