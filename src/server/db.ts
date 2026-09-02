import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized — call initDb() first');
  }
  return db;
}

/**
 * Where the migration runner reads its `.sql` files from.
 *
 * Exported because two other things need to agree with it: `scripts/copy-assets.mjs`,
 * which has to put the files there in the built output, and `cli/preflight.ts`, which
 * compares the files on disk against the rows in `schema_migrations`.
 */
export function migrationsDir(): string {
  return join(import.meta.dirname, 'migrations');
}

export interface MigrationFile {
  version: number;
  name: string;
  file: string;
}

/**
 * The migrations that exist on disk, in order.
 *
 * Throws when the directory is missing, and that is the point. It used to be a
 * `catch { return }` inside the runner, on the reasoning that "no migrations directory
 * yet — nothing to apply". The consequence was that `npm run build` produced a `dist`
 * with no `migrations/` in it — `tsc` emits only what it compiles — and the container
 * booted, ran zero migrations, printed the base-path banner, and died on the first
 * query with `no such table: audit_log`. A missing migrations directory is never a
 * legitimate state; it is a broken build, and it should say so.
 */
export function migrationFiles(dir: string = migrationsDir()): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new Error(
      `FATAL: the migrations directory is missing at ${dir}. ` +
        'In a built tree this means `npm run build` did not copy it — `tsc` emits only ' +
        'what it compiles, so `scripts/copy-assets.mjs` is what puts the .sql files in ' +
        `dist. Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const files = entries.filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    throw new Error(`FATAL: no .sql migrations found in ${dir}`);
  }

  return files.map((file) => {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (!match) {
      throw new Error(`Invalid migration filename: ${file} (expected NNN_name.sql)`);
    }
    return { version: parseInt(match[1]!, 10), name: match[2]!, file };
  });
}

/** The versions recorded as applied, ascending. */
export function appliedMigrations(database: Database.Database = getDb()): number[] {
  return (
    database.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as {
      version: number;
    }[]
  ).map((row) => row.version);
}

export function initDb(dbPath: string): Database.Database {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Hand-written numbered migration runner.
 * Migration files live in src/server/migrations/ and are named NNN_name.sql.
 * Applied migrations are tracked in the schema_migrations table.
 */
function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const dir = migrationsDir();
  const applied = new Set(appliedMigrations(database));

  for (const migration of migrationFiles(dir)) {
    if (applied.has(migration.version)) continue;

    const sql = readFileSync(join(dir, migration.file), 'utf-8');
    const apply = database.transaction(() => {
      database.exec(sql);
      database
        .prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
        .run(migration.version, migration.name);
    });
    apply();
  }
}
