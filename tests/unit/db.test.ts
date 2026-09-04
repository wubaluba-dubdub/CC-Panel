import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb, migrationFiles } from '../../src/server/db.js';

describe('Migration runner', () => {
  let dataDir: string | null = null;

  afterEach(() => {
    closeDb();
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
      dataDir = null;
    }
  });

  it('creates all tables from migrations', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'panel-db-test-'));
    const dbPath = join(dataDir, 'test.db');
    initDb(dbPath);

    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toContain('users');
    expect(tables).toContain('sessions');
    expect(tables).toContain('audit_log');
    expect(tables).toContain('secrets');
    expect(tables).toContain('schema_migrations');
    // M1.4 additions.
    expect(tables).toContain('auth_failures');
    expect(tables).toContain('recovery_codes');
    // 005 created `lockouts`; 007 dropped it. There is no per-IP or per-account
    // lockout anywhere in this application, and the absence of the table is the
    // cheapest way to keep one from being reintroduced by habit.
    expect(tables).not.toContain('lockouts');
  });

  it('records applied migrations', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'panel-db-test-'));
    const dbPath = join(dataDir, 'test.db');
    initDb(dbPath);

    const db = getDb();
    const migrations = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((r) => (r as { version: number }).version);

    // Derived from the files on disk rather than a literal: a hard-coded list means
    // every migration after this one starts by editing a test that is not about it,
    // and the property worth asserting is "every shipped migration is recorded", not
    // "there are exactly eight of them".
    expect(migrations).toEqual(migrationFiles().map((m) => m.version));
  });

  it('is idempotent — running twice does not fail', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'panel-db-test-'));
    const dbPath = join(dataDir, 'test.db');
    initDb(dbPath);
    closeDb();

    // Second init should not throw
    initDb(dbPath);
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as { c: number };
    expect(count.c).toBe(migrationFiles().length);
  });
});
