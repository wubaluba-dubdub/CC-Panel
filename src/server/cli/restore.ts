import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Report } from './report.js';
import { copyDatabase, inspectDatabase, isBusy, walSidecars } from './db-file.js';
import { defaultDatabasePath } from './backup.js';

/**
 * `npm run restore -- <path>` — put a snapshot back.
 *
 * **The refusal that matters.** If the database currently in place has an audit chain
 * that *verifies*, the restore stops and requires `--force`. The reasoning is that a
 * verifying chain is positive evidence that the live database is intact, and a restore
 * over it destroys history that nothing can recover — the audit log is append-only
 * precisely so that it cannot be edited, and overwriting the file is the one way around
 * that. A restore is for a database that is broken, lost, or being moved; if the live
 * one verifies, the operator is either doing something deliberate (and can say so) or
 * about to make a mistake.
 *
 * Everything else it does is in service of not making the situation worse:
 *
 * - **The incoming file is inspected before anything is touched.** `integrity_check`,
 *   the migration count, and the chain under the current key. A snapshot whose chain
 *   fails at its oldest row was almost certainly written under a *different*
 *   `PANEL_MASTER_KEY`, which means its encrypted secrets will not decrypt either — so
 *   that case is a failure with the reason named, not a warning to scroll past.
 * - **A safety copy of the current database is taken first**, through the same online
 *   backup API, so the state being replaced is still a consistent file afterwards.
 * - **The swap goes through a temporary file and a rename**, so an interrupted restore
 *   leaves either the old database or the new one, never half of each.
 * - **The old `-wal` and `-shm` are removed.** A stale WAL belonging to the *previous*
 *   database, sitting next to the restored one, is corruption with a plausible mtime.
 * - **It refuses outright if something holds a write lock**, `--force` included.
 *   Replacing a file underneath a running server is not a thing to be allowed to insist
 *   on. Stop the service first; the runbook says so.
 */

export interface RestoreOptions {
  /** The snapshot to restore from. */
  source: string;
  /** The live `panel.db`. Defaults to `<PANEL_DATA_DIR>/panel.db`. */
  target?: string;
  /** Overwrite a target whose chain currently verifies, or accept an unverifiable source. */
  force?: boolean;
  /** Skip the pre-restore copy of the current database. */
  noSafetyCopy?: boolean;
  masterKey?: string | undefined;
  write?: (text: string) => void;
  /** Injected for tests, so the safety-copy name is predictable. */
  timestamp?: string;
}

export interface RestoreResult {
  report: Report;
  exitCode: number;
  /** Where the replaced database was preserved, when it was. */
  safetyCopy: string | null;
  restored: boolean;
}

export async function restoreDatabase(opts: RestoreOptions): Promise<RestoreResult> {
  const report = new Report(opts.write);
  const source = resolve(opts.source);
  const target = resolve(opts.target ?? defaultDatabasePath());
  const masterKey = opts.masterKey ?? process.env.PANEL_MASTER_KEY;
  const stop = (): RestoreResult => ({
    report,
    exitCode: report.finish(),
    safetyCopy: null,
    restored: false,
  });

  report.section('Restore');
  report.info('source', source);
  report.info('target', target);

  if (!existsSync(source)) {
    report.fail('the snapshot exists', source);
    return stop();
  }
  if (source === target) {
    report.fail('the snapshot is not the target', 'refusing to restore a database over itself');
    return stop();
  }

  // ── The incoming file, before anything is touched ──────────────────────────
  report.section('The snapshot');
  try {
    const info = inspectDatabase(source, masterKey);
    if (info.integrity === 'ok') report.pass('integrity_check', 'ok');
    else {
      report.fail('integrity_check', info.integrity);
      return stop();
    }

    if (info.migrationsApplied === 0) {
      report.fail(
        'the snapshot is a panel database',
        'it has no schema_migrations table, so it is some other SQLite file',
      );
      return stop();
    }
    report.pass('schema', `${info.migrationsApplied} of ${info.migrationsShipped} migrations applied`);
    report.info('audit rows', String(info.auditRows));

    if (info.chain === null) {
      report.warn(
        'the snapshot verifies under this master key',
        'no usable PANEL_MASTER_KEY in this environment, so nothing confirms this snapshot is readable here',
      );
    } else if (info.chain.ok) {
      report.pass('the snapshot verifies under this master key', `${info.chain.checked} rows`);
    } else if (info.chain.hint === 'wrong_key_or_genesis' && opts.force !== true) {
      report.fail(
        'the snapshot verifies under this master key',
        `${info.chain.reason} at its oldest row (id ${info.chain.brokenAtId}). That is what a snapshot written under a DIFFERENT PANEL_MASTER_KEY looks like — and if the key is wrong for the log it is wrong for the encrypted secrets too, which will fail at the moment something reads them rather than now. Restore it with --force only if you know the key situation. See "Key rotation" in docs/SECURITY.md`,
      );
      return stop();
    } else if (opts.force !== true) {
      report.fail(
        'the snapshot verifies under this master key',
        `${info.chain.reason} at id ${info.chain.brokenAtId} — a break partway down the chain, which is the shape a tamper makes. Pass --force to restore it anyway`,
      );
      return stop();
    } else {
      report.warn(
        'the snapshot verifies under this master key',
        `${info.chain.reason} at id ${info.chain.brokenAtId} — restoring anyway because --force was given`,
      );
    }
  } catch (err) {
    report.fail('the snapshot is readable', err instanceof Error ? err.message : String(err));
    return stop();
  }

  // ── The database being replaced ────────────────────────────────────────────
  report.section('The database being replaced');
  if (isBusy(target)) {
    report.fail(
      'nothing is writing the target',
      'another process holds a write lock. Stop the panel before restoring — replacing the file underneath a running server is how one database becomes two halves of two. --force does not override this',
    );
    return stop();
  }

  if (!existsSync(target)) {
    report.info('target', 'does not exist yet, so there is nothing to overwrite');
  } else {
    const current = inspectDatabase(target, masterKey);
    report.info('current audit rows', String(current.auditRows));
    if (current.chain !== null && current.chain.ok) {
      if (opts.force !== true) {
        report.fail(
          'the current database is not intact',
          `its audit chain verifies over ${current.chain.checked} rows, which is positive evidence that it is fine. Restoring over it destroys history that nothing can recover. Pass --force if that is what you mean to do`,
        );
        return stop();
      }
      report.warn(
        'the current database is not intact',
        `its chain verifies over ${current.chain.checked} rows — overwriting it because --force was given`,
      );
    } else if (current.chain === null) {
      report.warn('the current database was checked', 'no usable master key, so its chain is unknown');
    } else {
      report.pass(
        'the current database is not intact',
        `${current.chain.reason} at id ${current.chain.brokenAtId} — which is a reason to restore`,
      );
    }
  }

  // ── The swap ───────────────────────────────────────────────────────────────
  report.section('Swapping the file');
  let safetyCopy: string | null = null;
  if (existsSync(target) && opts.noSafetyCopy !== true) {
    const stamp = (opts.timestamp ?? new Date().toISOString()).replace(/[:.]/g, '-');
    safetyCopy = `${target}.pre-restore-${stamp}`;
    try {
      // Through the backup API, not a copy: the thing being preserved has to be a
      // consistent database, not `panel.db` without its WAL.
      const copied = await copyDatabase(target, safetyCopy);
      report.pass('the replaced database was preserved', `${safetyCopy} (${copied.bytes} bytes)`);
    } catch (err) {
      report.fail(
        'the replaced database was preserved',
        `${err instanceof Error ? err.message : String(err)} — stopping rather than overwriting something that could not be saved first`,
      );
      return stop();
    }
  }

  const staging = `${target}.incoming-${process.pid}`;
  try {
    if (existsSync(staging)) unlinkSync(staging);
    // Copying through the backup API again rather than `cp`: the result is a single
    // file with no WAL of its own, which is exactly what should land at `target`.
    await copyDatabase(source, staging);
    renameSync(staging, target);
    report.pass('the snapshot is in place', `renamed onto ${target}`);
  } catch (err) {
    if (existsSync(staging)) unlinkSync(staging);
    report.fail('the snapshot is in place', err instanceof Error ? err.message : String(err));
    return { report, exitCode: report.finish(), safetyCopy, restored: false };
  }

  for (const sidecar of walSidecars(target)) {
    if (existsSync(sidecar)) {
      unlinkSync(sidecar);
      report.pass('stale WAL sidecar removed', sidecar);
    }
  }

  // ── What actually landed ───────────────────────────────────────────────────
  report.section('Verifying what landed');
  try {
    const info = inspectDatabase(target, masterKey);
    if (info.integrity === 'ok') report.pass('integrity_check', 'ok');
    else report.fail('integrity_check', info.integrity);

    report.info('audit rows', String(info.auditRows));
    if (info.migrationsApplied < info.migrationsShipped) {
      report.warn(
        'schema',
        `${info.migrationsApplied} of ${info.migrationsShipped} — the next boot will apply the rest`,
      );
    } else {
      report.pass('schema', `${info.migrationsApplied} of ${info.migrationsShipped} migrations`);
    }

    if (info.chain === null) {
      report.warn('audit chain verifies', 'no usable master key to check with');
    } else if (info.chain.ok) {
      report.pass('audit chain verifies', `${info.chain.checked} rows`);
    } else {
      report.fail(
        'audit chain verifies',
        `${info.chain.reason} at id ${info.chain.brokenAtId}${
          info.chain.hint === 'wrong_key_or_genesis' ? ' (hint: wrong key or genesis)' : ''
        }`,
      );
    }
  } catch (err) {
    report.fail('the restored database is readable', err instanceof Error ? err.message : String(err));
  }

  if (safetyCopy !== null) {
    report.section('If this was a mistake');
    report.info('the previous database is at', safetyCopy);
    report.info('to undo', `npm run restore -- ${safetyCopy} --force`);
  }

  return { report, exitCode: report.finish(), safetyCopy, restored: true };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const noSafetyCopy = args.includes('--no-safety-copy');
  const positional = args.filter((a) => !a.startsWith('--'));
  const source = positional[0];

  if (source === undefined) {
    process.stderr.write(
      'usage: npm run restore -- <snapshot.db> [--force] [--no-safety-copy]\n' +
        '       node dist/server/cli/restore.js <snapshot.db> [--force]\n\n' +
        'Stop the panel first. Refuses to overwrite a database whose audit chain\n' +
        'currently verifies unless --force is given.\n',
    );
    process.exit(2);
  }

  const result = await restoreDatabase({ source, force, noSafetyCopy });
  process.exit(result.exitCode);
}
