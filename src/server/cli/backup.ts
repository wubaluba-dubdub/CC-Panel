import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Report } from './report.js';
import { copyDatabase, inspectDatabase } from './db-file.js';

/**
 * `npm run backup -- <path>` — one consistent snapshot of `panel.db`.
 *
 * `cp panel.db somewhere` is unsafe and quietly so. The database runs in WAL mode, so a
 * committed row lives in `panel.db-wal` until a checkpoint folds it in: copying
 * `panel.db` alone yields an older database than the one being served, and copying the
 * two files a moment apart yields neither. SQLite's online backup API copies pages under
 * the engine's own locking and produces a single consistent file, which is what this
 * does.
 *
 * It then **verifies what it wrote** rather than reporting success on the strength of
 * the copy returning: `PRAGMA integrity_check`, the migration count, and the audit
 * chain under the current `PANEL_MASTER_KEY`. A backup that cannot be verified is not a
 * backup, and the moment to find that out is now rather than during a restore.
 *
 * The key is **not** in the backup, and must be stored separately — see *Backup and
 * restore* in `docs/DEPLOY.md`. Either half alone is useless: the file without the key
 * yields no readable secret and no verifiable log, and the key without the file yields
 * nothing at all.
 */

export interface BackupOptions {
  /** The live `panel.db`. Defaults to `<PANEL_DATA_DIR>/panel.db`. */
  source?: string;
  destination: string;
  /** Overwrite an existing destination. */
  force?: boolean;
  masterKey?: string | undefined;
  write?: (text: string) => void;
}

export interface BackupResult {
  report: Report;
  exitCode: number;
  bytes: number;
}

export function defaultDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PANEL_DATA_DIR ?? '/data', 'panel.db');
}

export async function backupDatabase(opts: BackupOptions): Promise<BackupResult> {
  const report = new Report(opts.write);
  const source = resolve(opts.source ?? defaultDatabasePath());
  const destination = resolve(opts.destination);

  report.section('Backup');
  report.info('source', source);
  report.info('destination', destination);

  if (!existsSync(source)) {
    report.fail('the source database exists', source);
    return { report, exitCode: report.finish(), bytes: 0 };
  }
  if (source === destination) {
    report.fail('the destination is not the source', 'refusing to back a database up onto itself');
    return { report, exitCode: report.finish(), bytes: 0 };
  }
  if (existsSync(destination) && opts.force !== true) {
    report.fail(
      'the destination is free',
      `${destination} already exists — pass --force to overwrite it. A silent overwrite of the previous backup is how one bad snapshot destroys the last good one`,
    );
    return { report, exitCode: report.finish(), bytes: 0 };
  }

  mkdirSync(dirname(destination), { recursive: true });
  // The backup API appends to whatever is there, so a stale file has to go first.
  if (existsSync(destination)) unlinkSync(destination);

  let bytes = 0;
  try {
    const copied = await copyDatabase(source, destination);
    bytes = copied.bytes;
    report.pass('snapshot written', `${copied.bytes} bytes, ${copied.totalPages} pages`);
  } catch (err) {
    report.fail('snapshot written', err instanceof Error ? err.message : String(err));
    return { report, exitCode: report.finish(), bytes: 0 };
  }

  report.section('Verifying the snapshot, not just the copy');
  try {
    const info = inspectDatabase(destination, opts.masterKey ?? process.env.PANEL_MASTER_KEY);

    if (info.integrity === 'ok') report.pass('integrity_check', 'ok');
    else report.fail('integrity_check', info.integrity);

    if (info.migrationsApplied === info.migrationsShipped) {
      report.pass('schema', `${info.migrationsApplied} of ${info.migrationsShipped} migrations`);
    } else {
      report.warn(
        'schema',
        `${info.migrationsApplied} applied, this build ships ${info.migrationsShipped} — the snapshot is of an older schema, which restores fine and then migrates forward`,
      );
    }

    report.info('audit rows', String(info.auditRows));

    if (info.chain === null) {
      report.warn(
        'audit chain verifies',
        'no usable PANEL_MASTER_KEY in this environment, so the chain could not be checked. The snapshot is still a snapshot — but nothing has confirmed it is readable',
      );
    } else if (info.chain.ok) {
      report.pass('audit chain verifies', `${info.chain.checked} rows`);
    } else {
      report.fail(
        'audit chain verifies',
        `${info.chain.reason} at id ${info.chain.brokenAtId}${
          info.chain.hint === 'wrong_key_or_genesis'
            ? ' — at the oldest surviving row, which usually means the master key in this environment is not the one the log was written with'
            : ''
        }`,
      );
    }
  } catch (err) {
    report.fail('the snapshot is a readable panel database', err instanceof Error ? err.message : String(err));
  }

  report.section('Store these two apart');
  report.info('the snapshot', destination);
  report.info('PANEL_MASTER_KEY', 'not in the snapshot, and not printed here — keep it somewhere else');

  return { report, exitCode: report.finish(), bytes };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const positional = args.filter((a) => !a.startsWith('--'));
  const destination = positional[0];

  if (destination === undefined) {
    process.stderr.write(
      'usage: npm run backup -- <destination.db> [--force]\n' +
        '       node dist/server/cli/backup.js <destination.db> [--force]\n\n' +
        'Writes one consistent snapshot of $PANEL_DATA_DIR/panel.db and verifies it.\n',
    );
    process.exit(2);
  }

  const result = await backupDatabase({ destination, force });
  process.exit(result.exitCode);
}
