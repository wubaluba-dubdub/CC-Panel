import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initCrypto } from '../../src/server/crypto.js';
import { closeDb, getDb, initDb, migrationFiles, migrationsDir } from '../../src/server/db.js';
import { AuditEvent, AuditService } from '../../src/server/services/audit.service.js';
import { SecretsRepository } from '../../src/server/services/secrets.service.js';
import { SessionService } from '../../src/server/services/session.service.js';
import { UserService } from '../../src/server/services/user.service.js';

/**
 * M2.2A — migration 012 applied to a database that already has rows. Every other
 * migration test here starts from zero, and M2.1.1 is live on a volume with real
 * users, sessions, a chained audit log and encrypted secrets. So this builds an
 * 011-era database, seeds it through the real services, and only then lets the real
 * runner apply 012 — the exact sequence the operator's next `npm run dev` performs.
 *
 * The assertions see: the seeded rows are byte-identical afterwards, the chain still
 * verifies under the same key, the secret still decrypts under its AAD, the runner's
 * bookkeeping reads [1..12], `projects` has exactly the twelve specified columns and
 * zero rows, and both UNIQUE constraints reject duplicates. They do not see: the
 * seven import columns' future semantics (only that they exist and are unwritten),
 * concurrent writers, whether a deployed image ships this file (build.test.ts's
 * question), or anything the M2.2B validation layer will do — nothing here stops a
 * writer that bypasses it.
 */
const KEY = Buffer.from('m'.repeat(32)).toString('base64');

describe('migration 012 over a populated 011 database', () => {
  let dir: string | null = null;

  afterEach(() => {
    closeDb();
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('leaves users, sessions, audit and secrets untouched, and adds projects', async () => {
    dir = mkdtempSync(join(tmpdir(), 'panel-m012-'));
    const dbPath = join(dir, 'panel.db');

    // Phase 1 — an 011-era database. The runner has no "stop at" knob, so this
    // replays its own loop (same files, same bookkeeping insert) for versions <= 11.
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    for (const m of migrationFiles().filter((f) => f.version <= 11)) {
      const sql = readFileSync(join(migrationsDir(), m.file), 'utf-8');
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
      })();
    }

    // Phase 2 — seed through the real services, the way 011-era code wrote them.
    initCrypto(KEY);
    await new UserService({ db }).seed('admin', 'correct-horse-battery-staple');
    new SessionService({ db }).create({ authLevel: 'full' });
    const audit = new AuditService({ db });
    audit.write({ event: AuditEvent.LoginSuccess, outcome: 'success' });
    audit.write({ event: AuditEvent.SessionCreated, outcome: 'success' });
    new SecretsRepository({ db }).set('global', 'telegram_bot_token', '1'.repeat(41));

    const before = {
      user: db.prepare('SELECT * FROM users').get(),
      session: db.prepare('SELECT token_hash, auth_level FROM sessions').get(),
      auditRows: db.prepare('SELECT id, ts, event, outcome, row_hash FROM audit_log ORDER BY id').all(),
      secretPayload: db.prepare("SELECT payload FROM secrets WHERE name = 'telegram_bot_token'").get(),
    };
    db.close();

    // Phase 3 — the real runner, opening the populated file and applying only 012.
    initDb(dbPath);
    const after = getDb();

    expect(
      (after.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map(
        (r) => r.version,
      ),
    ).toEqual(migrationFiles().map((m) => m.version));
    expect(after.prepare('SELECT * FROM users').get()).toEqual(before.user);
    expect(after.prepare('SELECT token_hash, auth_level FROM sessions').get()).toEqual(before.session);
    expect(after.prepare('SELECT id, ts, event, outcome, row_hash FROM audit_log ORDER BY id').all()).toEqual(
      before.auditRows,
    );
    expect(after.prepare("SELECT payload FROM secrets WHERE name = 'telegram_bot_token'").get()).toEqual(
      before.secretPayload,
    );

    // Not just unchanged rows: the chain still verifies and the payload still
    // decrypts under its (scope, name) AAD.
    expect(new AuditService({ db: after }).verify()).toMatchObject({ ok: true, checked: 2 });
    expect(new SecretsRepository({ db: after }).get('global', 'telegram_bot_token')?.reveal()).toBe('1'.repeat(41));

    // The new table: exactly the twelve specified columns, and empty — nothing writes it.
    const cols = (after.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      'id', 'uuid', 'slug', 'isolated_settings', 'created_at', 'origin', 'origin_ref',
      'origin_at', 'source_install_id', 'review_state', 'reviewed_at', 'artefacts_json',
    ]);
    expect((after.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c).toBe(0);

    // The schema's half of the slug guarantee: UNIQUE is real and byte-wise.
    const insert = after.prepare(
      "INSERT INTO projects (uuid, slug, isolated_settings, created_at) VALUES (?, ?, 0, '2026-09-18T00:00:00.000Z')",
    );
    insert.run(randomUUID(), 'alpha');
    insert.run('fixed-uuid', 'beta');
    expect(() => insert.run(randomUUID(), 'alpha')).toThrow(/UNIQUE constraint failed: projects\.slug/);
    expect(() => insert.run('fixed-uuid', 'gamma')).toThrow(/UNIQUE constraint failed: projects\.uuid/);
  });
});
