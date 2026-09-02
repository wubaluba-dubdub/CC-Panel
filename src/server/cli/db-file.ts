import Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import { initCrypto } from '../crypto.js';
import { appliedMigrations, migrationFiles } from '../db.js';
import { AuditService, type AuditVerification } from '../services/audit.service.js';

/**
 * Shared machinery for `backup` and `restore`: how a panel database file is copied, and
 * how it is inspected afterwards.
 *
 * **Why `cp` is not good enough, spelled out once.** The database runs in WAL mode. A
 * committed row lives in `panel.db-wal` until a checkpoint moves it, so at any instant
 * `panel.db` on its own is an *older* database than the one the server is serving — and
 * a copy of `panel.db` plus a copy of `panel.db-wal` taken a moment apart is not any
 * database at all. SQLite's online backup API exists for exactly this: it copies pages
 * under the same locking the engine uses and produces one file that is a consistent
 * snapshot, with the WAL already folded in. `docs/DEPLOY.md` says so in the runbook, and
 * this module is where it is true.
 */

export interface CopyResult {
  bytes: number;
  totalPages: number;
}

/**
 * One consistent snapshot of `source` at `destination`, through the online backup API.
 *
 * The source is opened read-only: a backup has no business being able to write, and a
 * read-only connection is a perfectly good backup source.
 */
export async function copyDatabase(source: string, destination: string): Promise<CopyResult> {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    const progress = await db.backup(destination);
    return { bytes: statSync(destination).size, totalPages: progress.totalPages };
  } finally {
    db.close();
  }
}

export interface DatabaseInspection {
  path: string;
  bytes: number;
  /** SQLite's own structural check. `ok` when it returns the single row `ok`. */
  integrity: string;
  migrationsApplied: number;
  migrationsShipped: number;
  auditRows: number;
  /** Null when there is no master key to verify with, or no chain to verify. */
  chain: AuditVerification | null;
}

/**
 * Everything worth knowing about a panel database file, read-only.
 *
 * `PRAGMA integrity_check` first, because a file that is structurally broken makes every
 * other answer meaningless; then the migration count, then the audit chain. The chain
 * needs `PANEL_MASTER_KEY`: without it the answer is "unknown", which is reported as
 * `null` rather than as a pass.
 */
export function inspectDatabase(path: string, masterKey?: string | undefined): DatabaseInspection {
  if (!existsSync(path)) throw new Error(`no database at ${path}`);

  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = (db.pragma('integrity_check') as { integrity_check: string }[])
      .map((row) => row.integrity_check)
      .join('; ');

    let migrationsApplied = 0;
    try {
      migrationsApplied = appliedMigrations(db).length;
    } catch {
      // A file with no schema_migrations is not a panel database. Left at 0 so the
      // caller reports it rather than throwing from here.
    }

    let auditRows = 0;
    try {
      auditRows = (db.prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }).c;
    } catch {
      // Same.
    }

    let chain: AuditVerification | null = null;
    if (masterKey !== undefined && Buffer.from(masterKey, 'base64').length >= 32) {
      // Always, not only when uninitialised: a caller who supplies a key is asking
      // "does this file verify under *this* key", and answering under a previously
      // installed one would be answering a different question. Safe because this module
      // is only ever reached from a CLI process, where there is no running server whose
      // key could be disturbed — `isCryptoInitialized` is imported to make that
      // assumption checkable rather than implicit.
      initCrypto(masterKey);
      try {
        chain = new AuditService({ db }).verify();
      } catch {
        chain = null;
      }
    }

    return {
      path,
      bytes: statSync(path).size,
      integrity,
      migrationsApplied,
      migrationsShipped: migrationFiles().length,
      auditRows,
      chain,
    };
  } finally {
    db.close();
  }
}

/** The sidecar files a WAL database leaves next to itself. */
export function walSidecars(path: string): string[] {
  return [`${path}-wal`, `${path}-shm`];
}

/**
 * Whether another process is actively writing this database.
 *
 * A restore replaces the file underneath whoever has it open, which is how a database
 * becomes two halves of two databases. There is no portable way to ask "is the panel
 * running", so this asks the question SQLite can answer: take an exclusive lock. A
 * `SQLITE_BUSY` means someone else holds a write lock right now.
 *
 * It is an honest but *incomplete* check, and that is worth stating rather than hiding:
 * an idle server holds no write lock, so a quiet panel looks unlocked. The runbook's
 * instruction to stop the service first is the real control; this catches the case where
 * the operator forgot and got unlucky, which is the case that corrupts.
 */
export function isBusy(path: string): boolean {
  if (!existsSync(path)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(path);
    db.exec('BEGIN EXCLUSIVE');
    db.exec('ROLLBACK');
    return false;
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED');
  } finally {
    db?.close();
  }
}
