import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initCrypto } from '../crypto.js';
import { closeDb, initDb } from '../db.js';
import { loadEnv, type Env } from '../env.js';
import { AuditService } from '../services/audit.service.js';
import { NotifyService } from '../services/notify.service.js';
import { SecretsRepository } from '../services/secrets.service.js';
import { readTelegramCredentials } from '../services/telegram-config.js';
import { TelegramTransport } from '../services/telegram.transport.js';
import { createBasePathElider, redactSecrets } from '../plugins/logger-redaction.js';
import { resolveBasePath } from '../app.js';

/**
 * The shared half of `telegram:set`, `telegram:test` and `telegram:discover`.
 *
 * These exist because the alternative, for an operator who is not an expert, is a
 * multi-step `curl` sequence involving a session cookie, a CSRF token and a step-up — to
 * configure a feature whose whole purpose is to be reachable when they are *not* at the
 * panel. They are in the same family as `preflight`, `backup` and `restore`: shipped in
 * the image, runnable in Railway's shell as `node dist/server/cli/<name>.js`, one
 * pass/fail line per fact, and **no secret value is ever printed**.
 *
 * Unlike `preflight`, these open the database the normal way. `preflight` must not change
 * anything and therefore opens read-only; two of these three exist to write.
 */

export interface PanelContext {
  env: Env;
  secrets: SecretsRepository;
  audit: AuditService;
  transport: TelegramTransport;
  notify: NotifyService;
  close(): void;
}

export function openPanel(): PanelContext {
  const env = loadEnv();
  const dataDir = env.PANEL_DATA_DIR;
  initDb(join(dataDir, 'panel.db'));
  initCrypto(env.PANEL_MASTER_KEY);

  // Read rather than generated: a CLI command must not be the thing that mints a base
  // path, because it would print the banner into a terminal nobody is watching and the
  // server would then adopt it. `resolveBasePath` reuses the persisted value when there
  // is one, which there is by the time anyone runs these.
  const basePath = resolveBasePath(env);
  const secrets = new SecretsRepository();
  const audit = new AuditService({ basePath });
  const elide = createBasePathElider(basePath);

  const transport = new TelegramTransport({
    credentials: () => readTelegramCredentials(secrets),
    sanitise: (text) => elide(redactSecrets(text)),
    ...(env.PANEL_OUTBOUND_PROXY !== undefined ? { proxyUrl: env.PANEL_OUTBOUND_PROXY } : {}),
  });

  const notify = new NotifyService({
    transport,
    audit,
    basePath,
    locale: env.PANEL_NOTIFY_LOCALE,
  });

  return {
    env,
    secrets,
    audit,
    transport,
    notify,
    close: () => closeDb(),
  };
}

/**
 * Reads one value from a prompt, or from a pipe when stdin is not a terminal.
 *
 * **Never from `argv`.** A token on a command line is in the shell history, in the
 * process list for as long as the command runs, and in whatever is recording the session
 * — which for a Railway web shell is a browser tab. Echo is off on a terminal, so it is
 * not in the scrollback either.
 */
export async function promptSecret(label: string): Promise<string> {
  if (process.stdin.isTTY !== true) {
    // Piped: `printf '%s' "$TOKEN" | node dist/server/cli/telegram-set.js --token`
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trim();
  }

  process.stdout.write(`${label}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return await new Promise<string>((resolvePromise) => {
    let value = '';
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        // Enter, or a lone carriage return from a Windows terminal.
        if (byte === 0x0d || byte === 0x0a) {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          resolvePromise(value.trim());
          return;
        }
        // Ctrl-C: leave the terminal in a usable state rather than raw.
        if (byte === 0x03) {
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        // Backspace / delete.
        if (byte === 0x7f || byte === 0x08) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    };
    process.stdin.on('data', onData);
  });
}

/** True when this module is the entry point, so importing it in a test runs nothing. */
export function isMain(url: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === resolve(fileURLToPath(url));
}

/** `--flag` present in argv. Values are never taken from argv; see {@link promptSecret}. */
export function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}
