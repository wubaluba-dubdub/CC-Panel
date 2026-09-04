import Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initCrypto } from '../crypto.js';
import { loadEnv, type Env } from '../env.js';
import { appliedMigrations, migrationFiles } from '../db.js';
import { cookieProfileFor } from '../plugins/cookies.js';
import { AuditService } from '../services/audit.service.js';
import { SecretsRepository } from '../services/secrets.service.js';
import { telegramConfigStatus } from '../services/telegram-config.js';
import { listenHostFor } from '../utils/listen-host.js';
import { proxyBootWarning } from '../utils/outbound-http.js';
import { resolvePublicOrigin } from '../utils/public-origin.js';
import { MIN_PASSWORD_LENGTH, WEAK_PASSWORDS } from '../utils/weak-passwords.js';
import { Report, describeSecret } from './report.js';

/**
 * `npm run preflight` — validate the whole configuration without starting anything.
 *
 * Run it before a first deployment and after every change to an environment variable.
 * Every check is a line, every line is a pass or a fail, and any failure is a non-zero
 * exit, so it can sit in front of a deploy rather than being read by a human who
 * already believes the configuration is right.
 *
 * Two design constraints worth stating, because both are easy to get wrong:
 *
 * - **It must not change anything.** In particular it must not *apply* migrations,
 *   which is what `initDb()` does as a side effect of opening the database. So it opens
 *   its own read-only connection and compares the rows in `schema_migrations` against
 *   the files this build shipped. A preflight that migrated the database would be a
 *   deployment step disguised as a check.
 * - **It must not print a secret.** For each credential it prints whether it is set and
 *   how many characters it has, which catches the two mistakes that actually happen —
 *   a variable that never reached the environment, and a value truncated by a paste —
 *   and reveals nothing. The **base path** is included in that rule: it is the whole
 *   obscurity layer, and a command that prints it puts it in shell history and
 *   scrollback.
 */

export interface PreflightOptions {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
}

export interface PreflightResult {
  report: Report;
  exitCode: number;
}

/** Opens the panel database read-only, or explains why it could not. */
function openReadOnly(dbPath: string): { db: Database.Database } | { error: string } {
  try {
    return { db: new Database(dbPath, { readonly: true, fileMustExist: true }) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function checkDirectoryWritable(dir: string): { ok: true } | { ok: false; reason: string } {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `cannot create ${dir}: ${err instanceof Error ? err.message : err}` };
  }
  // Settled by writing, not by inspecting: `-w` and a mode check both lie under an
  // ACL, and this is the same probe `checkDataWritable` does in the server.
  const probe = join(dir, `.preflight-${process.pid}`);
  try {
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `not writable: ${err instanceof Error ? err.message : err}` };
  }
}

export function runPreflight(opts: PreflightOptions = {}): PreflightResult {
  const raw = opts.env ?? process.env;
  const report = new Report(opts.write);

  // ── Required variables ──────────────────────────────────────────────────────
  report.section('Required configuration');

  const masterKey = raw.PANEL_MASTER_KEY;
  report.info('PANEL_MASTER_KEY', describeSecret(masterKey));
  if (masterKey === undefined || masterKey.length === 0) {
    report.fail('master key present', 'PANEL_MASTER_KEY is not set — the panel cannot start');
  } else {
    const decoded = Buffer.from(masterKey, 'base64');
    // base64 decoding never throws in Node; it discards what it cannot parse. So the
    // length of the *result* is the only real check, and it is also the check that
    // matters: a truncated paste decodes cleanly to too few bytes.
    if (decoded.length < 32) {
      report.fail(
        'master key is at least 32 bytes when base64-decoded',
        `decoded to ${decoded.length} bytes — check for a truncated paste or a value that is not base64`,
      );
    } else {
      report.pass('master key decodes to at least 32 bytes', `${decoded.length} bytes`);
    }
  }

  const nodeEnv = raw.NODE_ENV ?? 'development';
  report.info('NODE_ENV', nodeEnv);
  if (nodeEnv !== 'production') {
    report.warn(
      'NODE_ENV is production',
      `it is "${nodeEnv}" — correct for local work, wrong for a deployment (HSTS is off, and the loopback allowances in the Host and Origin checks are on)`,
    );
  } else {
    report.pass('NODE_ENV is production');
  }

  // ── Env parsing, which is itself a check ────────────────────────────────────
  let env: Env | null = null;
  try {
    // The same function the server boots through, on the same environment. If this
    // throws, the server would refuse to start — so the check is not "does the
    // configuration look right" but "would it boot".
    env = loadEnv(raw);
    report.pass('env.ts accepts the environment');
  } catch (err) {
    report.fail('env.ts accepts the environment', err instanceof Error ? err.message : String(err));
  }

  // ── Public origin, and the three things it decides ─────────────────────────
  report.section('Public origin — cookie name, Secure attribute, Origin/Host check');
  report.info('PANEL_PUBLIC_URL', raw.PANEL_PUBLIC_URL ?? 'not set');
  report.info('RAILWAY_PUBLIC_DOMAIN', raw.RAILWAY_PUBLIC_DOMAIN ?? 'not set');

  if (env !== null) {
    try {
      const origin = resolvePublicOrigin(env);
      report.pass('public origin resolves', `${origin.origin} (from ${origin.source})`);

      if (nodeEnv === 'production' && !origin.secure) {
        report.fail('scheme is consistent with NODE_ENV', 'production requires an https origin');
      } else if (!origin.secure && !origin.loopback) {
        report.fail('scheme is consistent with the host', 'plain http on a routable host');
      } else {
        report.pass(
          'scheme is consistent with NODE_ENV',
          origin.secure ? 'https' : `http on loopback, outside production`,
        );
      }

      try {
        const profile = cookieProfileFor(origin, nodeEnv);
        report.pass(
          'cookie profile',
          profile.secure
            ? 'secure — the session cookie carries the name prefix and the Secure attribute'
            : 'development — no prefix and no Secure attribute, which is the only profile Chrome will accept over loopback http',
        );
      } catch (err) {
        report.fail('cookie profile', err instanceof Error ? err.message : String(err));
      }
    } catch (err) {
      report.fail('public origin resolves', err instanceof Error ? err.message : String(err));
    }
  }

  // ── Networking ─────────────────────────────────────────────────────────────
  report.section('Networking');
  if (env !== null) {
    const listen = listenHostFor(env);
    report.pass('listen host', `${listen.host}:${env.PORT} (from ${listen.source})`);
    if (listen.host === '127.0.0.1' && nodeEnv === 'production') {
      report.fail(
        'listen host is reachable from outside the container',
        'loopback in production means the edge cannot reach the service, while the logs still say the server is listening',
      );
    }
    report.pass(
      'PANEL_TRUST_PROXY',
      env.PANEL_TRUST_PROXY
        ? 'on — correct behind Railway: X-Forwarded-Proto is honoured, so a bypassed TLS terminator is a 403'
        : 'off',
    );
    if (!env.PANEL_TRUST_PROXY) {
      report.warn(
        'PANEL_TRUST_PROXY is on',
        'off silently disables the scheme-downgrade check and records the proxy address instead of the client; see docs/DEPLOY.md',
      );
    }
  }

  // ── Notifications ──────────────────────────────────────────────────────────
  report.section('Notifications (no value is printed)');
  // A proxy URL is a credential under this command's rule: it can carry
  // `user:password@host`, so it gets the same set-or-not-set-and-a-length treatment as
  // the master key rather than being echoed for convenience.
  report.info('PANEL_OUTBOUND_PROXY', describeSecret(raw.PANEL_OUTBOUND_PROXY));
  const proxyWarning = proxyBootWarning(raw.PANEL_OUTBOUND_PROXY, nodeEnv);
  if (proxyWarning !== null) report.warn('outbound proxy is loopback or unset', proxyWarning);

  const includeLinks =
    raw.PANEL_NOTIFY_INCLUDE_LINKS === 'true' || raw.PANEL_NOTIFY_INCLUDE_LINKS === '1';
  report.info('PANEL_NOTIFY_LOCALE', raw.PANEL_NOTIFY_LOCALE ?? 'en (default)');
  if (includeLinks) {
    report.warn(
      'PANEL_NOTIFY_INCLUDE_LINKS is off',
      'it is on, so every notification ends with a link containing the base path. Anyone who can read that chat can reach your login page, and Telegram stores the message permanently',
    );
  } else {
    report.pass('PANEL_NOTIFY_INCLUDE_LINKS', 'off — no notification carries the base path');
  }

  // ── The base path, described and never printed ─────────────────────────────
  report.section('Base path (value never printed)');
  const dataDir = env?.PANEL_DATA_DIR ?? raw.PANEL_DATA_DIR ?? '/data';
  const instanceFile = join(dataDir, 'config', 'instance.json');
  if (raw.PANEL_BASE_PATH !== undefined && raw.PANEL_BASE_PATH.length > 0) {
    report.pass('PANEL_BASE_PATH', `set from the environment, ${raw.PANEL_BASE_PATH.length} characters`);
    if (raw.PANEL_BASE_PATH.length < 16) {
      report.warn(
        'base path is long enough to be worth having',
        `${raw.PANEL_BASE_PATH.length} characters — the generated form is 22; obscurity is not the boundary, but a short one is not obscurity either`,
      );
    }
  } else if (existsSync(instanceFile)) {
    report.pass('base path', `persisted in ${instanceFile}, and will be reused`);
  } else {
    report.info('base path', 'not set and not yet persisted — one will be generated and printed once at first boot');
  }

  // ── Data directory ─────────────────────────────────────────────────────────
  report.section('Data directory');
  report.info('PANEL_DATA_DIR', dataDir);
  const writable = checkDirectoryWritable(dataDir);
  if (writable.ok) {
    report.pass('data directory is writable', resolve(dataDir));
  } else {
    report.fail('data directory is writable', writable.reason);
  }

  // ── The database, opened read-only so nothing is migrated ───────────────────
  report.section('Database');
  const dbPath = join(dataDir, 'panel.db');
  const shipped = (() => {
    try {
      return migrationFiles().length;
    } catch (err) {
      report.fail('this build ships its migrations', err instanceof Error ? err.message : String(err));
      return null;
    }
  })();
  if (shipped !== null) report.pass('migrations in this build', `${shipped} files`);

  if (!existsSync(dbPath)) {
    report.info(
      'database',
      `${dbPath} does not exist yet — it will be created and migrated on first boot`,
    );
    if (raw.PANEL_ADMIN_USERNAME === undefined || raw.PANEL_ADMIN_PASSWORD === undefined) {
      report.fail(
        'first boot has credentials to seed the one user from',
        'there is no database and no PANEL_ADMIN_USERNAME/PANEL_ADMIN_PASSWORD pair — the panel would boot with no account and no way to make one',
      );
    } else {
      report.pass('first boot can seed the one user', 'both admin variables are present');
    }
  } else {
    const opened = openReadOnly(dbPath);
    if ('error' in opened) {
      report.fail('database opens read-only', opened.error);
    } else {
      const { db } = opened;
      try {
        report.pass('database opens read-only', `${statSync(dbPath).size} bytes`);

        let applied: number[] = [];
        try {
          applied = appliedMigrations(db);
          if (shipped !== null && applied.length < shipped) {
            report.fail(
              'all migrations are applied',
              `${applied.length} of ${shipped} — the next boot will apply the rest, but a running server on this file is serving a partial schema`,
            );
          } else {
            report.pass('all migrations are applied', `${applied.length} of ${shipped ?? applied.length}`);
          }
        } catch (err) {
          report.fail('schema_migrations is readable', err instanceof Error ? err.message : String(err));
        }

        // Admin credentials: both, or neither with a user already there.
        try {
          const users = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
          const hasUsername = raw.PANEL_ADMIN_USERNAME !== undefined;
          const hasPassword = raw.PANEL_ADMIN_PASSWORD !== undefined;
          report.info('PANEL_ADMIN_USERNAME', hasUsername ? 'set' : 'not set');
          report.info('PANEL_ADMIN_PASSWORD', describeSecret(raw.PANEL_ADMIN_PASSWORD));

          if (users > 0 && !hasUsername && !hasPassword) {
            report.pass(
              'admin credentials',
              'the user exists and neither variable is set, which is the state to be in after a first boot',
            );
          } else if (users > 0) {
            report.warn(
              'admin credentials',
              'the user already exists, so these are ignored. Remove them — a plaintext password does not need to outlive first boot',
            );
          } else if (hasUsername && hasPassword) {
            report.pass('admin credentials', 'both present, and there is no user yet');
          } else {
            report.fail(
              'admin credentials',
              'there is no user, and the two variables are not both present — the panel would refuse to boot',
            );
          }

          if (hasPassword) {
            const password = raw.PANEL_ADMIN_PASSWORD!;
            if (password.length < MIN_PASSWORD_LENGTH) {
              report.fail('admin password length', `${password.length} characters, minimum is ${MIN_PASSWORD_LENGTH}`);
            } else if (WEAK_PASSWORDS.includes(password.toLowerCase())) {
              report.fail('admin password is not on the weak list', 'it is');
            }
          }

          report.info('users in the database', String(users));
        } catch (err) {
          report.fail('users table is readable', err instanceof Error ? err.message : String(err));
        }

        // The audit chain. Needs the master key, which is the point: this check is
        // simultaneously "is the log intact" and "is this the key it was written with".
        if (masterKey !== undefined && Buffer.from(masterKey, 'base64').length >= 32) {
          try {
            initCrypto(masterKey);

            // The Telegram pair, through the same repository the server uses, so this
            // also proves the stored payloads decrypt under this key. Set or not set and
            // a length — never `mask()`, which would reveal four of the nine digits of a
            // chat id every time anyone ran this command.
            try {
              const telegram = telegramConfigStatus(new SecretsRepository({ db }));
              const describePresence = (presence: { set: boolean; length: number | null }): string =>
                presence.set ? `set, ${presence.length} characters` : 'not set';
              report.info('telegram bot token', describePresence(telegram.botToken));
              report.info('telegram chat id', describePresence(telegram.chatId));
              if (telegram.botToken.set !== telegram.chatId.set) {
                report.warn(
                  'telegram configuration is complete',
                  'one of the two values is missing, so notifications queue and never deliver. Run telegram:set',
                );
              }
            } catch (err) {
              report.fail(
                'stored secrets decrypt',
                err instanceof Error ? err.message : String(err),
              );
            }
            const verification = new AuditService({ db }).verify();
            if (verification.ok) {
              report.pass('audit chain verifies', `${verification.checked} rows`);
            } else if (verification.hint === 'wrong_key_or_genesis') {
              report.fail(
                'audit chain verifies',
                `${verification.reason} at id ${verification.brokenAtId} — this is the oldest surviving row, which is far more likely a wrong PANEL_MASTER_KEY (or a backup restored under a different one) than a tamper. See "Key rotation" in docs/SECURITY.md`,
              );
            } else if (verification.reason === 'unchained_row') {
              // Found by running this command against a development database: rows
              // written before migration 008 carry no hash until `initChain()` backfills
              // them, and that runs at *boot* — so a database whose server has not
              // started since M1.5 reports this on a log nobody has touched. Calling
              // that "the shape a tamper makes" would be exactly the false alarm the
              // `hint` in part 1.2 exists to prevent, one layer up.
              report.warn(
                'audit chain verifies',
                `row ${verification.brokenAtId} carries no hash. If this database predates migration 008 that is expected — the next boot chains those rows and this becomes a pass. If it does not, a row was inserted by hand`,
              );
            } else {
              report.fail(
                'audit chain verifies',
                `${verification.reason} at id ${verification.brokenAtId} — a break partway down the chain. This is the shape a tamper makes`,
              );
            }
          } catch (err) {
            report.fail('audit chain verifies', err instanceof Error ? err.message : String(err));
          }
        }
      } finally {
        db.close();
      }
    }
  }

  return { report, exitCode: report.finish() };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  process.stdout.write('Preflight — configuration check. No secret value is printed.\n');
  process.stdout.write(`Working from ${dirname(fileURLToPath(import.meta.url))}\n`);
  process.exit(runPreflight().exitCode);
}
