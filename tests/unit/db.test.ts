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

  it('keeps the notification queue and its state through migration 010\'s rebuild', () => {
    // 010 cannot ALTER a CHECK constraint, so it rebuilds both tables. Two things have to
    // survive that: the `kind` list has to be the widened one, and — the reason the
    // migration copies rows rather than recreating empty tables — a pending row is an
    // alert the operator has not been told about yet, and the queue is the only place it
    // exists.
    dataDir = mkdtempSync(join(tmpdir(), 'panel-db-test-'));
    initDb(join(dataDir, 'test.db'));
    const db = getDb();

    const insert = db.prepare(
      `INSERT INTO notification_queue (created_at, kind, event_json, next_attempt_at)
       VALUES ('2026-01-01T00:00:00.000Z', ?, '{}', '2026-01-01T00:00:00.000Z')`,
    );
    for (const kind of [
      'turn_complete',
      'resource_alert',
      'security_alert',
      'test',
      'oom_kill',
      'unclean_restart',
    ]) {
      expect(() => insert.run(kind), kind).not.toThrow();
    }
    // And the constraint is still a constraint. A kind added to `NotifyEvent` without a
    // migration fails here rather than at the first alert of that kind, in production.
    expect(() => insert.run('something_new')).toThrow(/CHECK constraint failed/);

    // The single state row survived with the watchdog's columns defaulted, so a first
    // tick reads `below` and a null OOM baseline rather than crashing on a missing row.
    const state = db.prepare('SELECT * FROM notification_state WHERE id = 1').get() as Record<
      string,
      unknown
    >;
    expect(state).toMatchObject({
      dropped: 0,
      memory_state: 'below',
      memory_alerted: 0,
      disk_state: 'below',
      oom_kills: null,
    });
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
