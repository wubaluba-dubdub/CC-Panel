import { z } from 'zod';
import { WEAK_PASSWORDS, MIN_PASSWORD_LENGTH } from './utils/weak-passwords.js';

const envSchema = z.object({
  PANEL_MASTER_KEY: z.string().min(1, 'PANEL_MASTER_KEY is required'),
  // Optional on purpose. These two seed the single user on first boot and are
  // never read again; once the user exists the operator is told to remove them
  // (see seedAdminUser in services/user.service.ts). Requiring them forever would
  // mean the plaintext password has to stay in the Railway environment for the
  // life of the deployment, which is exactly what we want to avoid. Boot fails
  // later, with a clear message, if there is no user *and* no credentials.
  PANEL_ADMIN_USERNAME: z.string().min(1).optional(),
  PANEL_ADMIN_PASSWORD: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `PANEL_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .optional(),
  PANEL_BASE_PATH: z.string().optional(),
  // The origin the panel is reached at. Read only by utils/public-origin.ts,
  // which is the one place that decides both the cookie profile and the expected
  // Origin/Host — see the comment there for why that must be a single decision.
  PANEL_PUBLIC_URL: z.string().min(1).optional(),
  // Injected by Railway. Always fronted by its TLS terminator, so it implies
  // https. Used only as a fallback when PANEL_PUBLIC_URL is absent.
  RAILWAY_PUBLIC_DOMAIN: z.string().min(1).optional(),
  PANEL_TRUST_PROXY: z.string().optional(),
  PANEL_DATA_DIR: z.string().optional(),
  PORT: z.string().optional(),
  // Which address to bind. Resolved by utils/listen-host.ts, which defaults to the
  // wildcard in a container or in production and to loopback in development — see
  // the comment there for why one hard-coded value was wrong in both directions.
  PANEL_LISTEN_HOST: z.string().optional(),
  // Set to '1' by the Dockerfile. A fact the image asserts about itself, rather than
  // something inferred from the filesystem.
  PANEL_IN_CONTAINER: z.string().optional(),
  // Where outbound notification requests are dispatched through. An environment
  // variable and not a stored secret: it belongs in the platform's variable store
  // beside PANEL_MASTER_KEY, it is read once at boot, and a panel that cannot reach
  // its own database has no business decrypting a proxy URL to find out why. It may
  // carry credentials, so it is never printed and never logged — `app.ts` hands it to
  // the redacting log destination as a literal to elide, and `preflight` reports it as
  // set or not set.
  PANEL_OUTBOUND_PROXY: z.string().optional(),
  // Whether a notification may end with a deep link into the panel. Off by default,
  // because the link contains the base path, and a Telegram message is permanent
  // storage the panel does not control — synced to every device the operator has ever
  // signed in from.
  PANEL_NOTIFY_INCLUDE_LINKS: z.string().optional(),
  // Which language notifications are rendered in. The one place the server holds a
  // locale, because a Telegram message has no client to render it.
  PANEL_NOTIFY_LOCALE: z.enum(['en', 'fa']).optional(),
  // The always-on resource watcher. On by default: the panel could already report a
  // failed login and not the thing that actually kills it. Off is for a development box
  // where a nearly-full disk would queue alerts nobody configured a transport for.
  PANEL_WATCHDOG_ENABLED: z.string().optional(),
  // The alert thresholds, as whole percentages. One per rule, because the clear
  // threshold is derived from it (HYSTERESIS_POINTS in services/resource-alerts.ts) —
  // an operator who could set both could set the clear threshold above the alert one,
  // which is not a hysteresis band but a machine that alternates on every sample.
  PANEL_WATCHDOG_MEMORY_PERCENT: z.string().optional(),
  PANEL_WATCHDOG_DISK_PERCENT: z.string().optional(),
  NODE_ENV: z.string().optional(),
});

export interface Env {
  PANEL_MASTER_KEY: string;
  PANEL_ADMIN_USERNAME?: string;
  PANEL_ADMIN_PASSWORD?: string;
  PANEL_BASE_PATH?: string;
  PANEL_PUBLIC_URL?: string;
  RAILWAY_PUBLIC_DOMAIN?: string;
  PANEL_TRUST_PROXY: boolean;
  PANEL_DATA_DIR: string;
  PORT: number;
  PANEL_LISTEN_HOST?: string;
  PANEL_IN_CONTAINER?: string;
  /** Never log this value. See the schema comment. */
  PANEL_OUTBOUND_PROXY?: string;
  PANEL_NOTIFY_INCLUDE_LINKS: boolean;
  PANEL_NOTIFY_LOCALE: 'en' | 'fa';
  PANEL_WATCHDOG_ENABLED: boolean;
  /** Whole percentage, clamped to 10–99 by `clampPercent`. */
  PANEL_WATCHDOG_MEMORY_PERCENT: number;
  PANEL_WATCHDOG_DISK_PERCENT: number;
  NODE_ENV: string;
}

/**
 * A whole percentage, or a boot failure naming the variable.
 *
 * Not a silent fallback to the default: a typo in a threshold is the kind of mistake
 * that produces a panel which looks configured and never alerts, and the only place it
 * would ever be noticed is the incident it failed to report.
 */
function parsePercent(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`${name} must be a whole percentage between 1 and 100 (got "${raw}")`);
  }
  return value;
}

/**
 * Parses and validates the environment.
 *
 * `source` defaults to `process.env` and exists for one caller: `cli/preflight.ts`,
 * which has to be able to validate a *supplied* environment so its own tests can drive
 * a broken one without mutating the process. Nothing in the server passes it.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const raw = envSchema.parse(source);

  // Validate master key length (must be 32 bytes when decoded from base64)
  let masterKeyBytes: Buffer;
  try {
    masterKeyBytes = Buffer.from(raw.PANEL_MASTER_KEY, 'base64');
  } catch {
    throw new Error('PANEL_MASTER_KEY must be valid base64');
  }
  if (masterKeyBytes.length < 32) {
    throw new Error(`PANEL_MASTER_KEY must be at least 32 bytes (got ${masterKeyBytes.length})`);
  }

  // Validate password not in weak list
  if (
    raw.PANEL_ADMIN_PASSWORD !== undefined &&
    WEAK_PASSWORDS.includes(raw.PANEL_ADMIN_PASSWORD.toLowerCase())
  ) {
    throw new Error('PANEL_ADMIN_PASSWORD is too weak (matches known-weak list)');
  }

  const trustProxy = raw.PANEL_TRUST_PROXY !== undefined
    ? raw.PANEL_TRUST_PROXY === 'true' || raw.PANEL_TRUST_PROXY === '1'
    : true; // default true for Railway

  const port = raw.PORT ? parseInt(raw.PORT, 10) : 3000;
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${raw.PORT}`);
  }

  const dataDir = raw.PANEL_DATA_DIR ?? '/data';

  // Parsed here so a malformed proxy URL is a boot failure with a clear message rather
  // than an `ECONNREFUSED` from the first notification, half an hour later, in a code
  // path nobody is watching. The value itself is not echoed into the error.
  if (raw.PANEL_OUTBOUND_PROXY !== undefined && raw.PANEL_OUTBOUND_PROXY.length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(raw.PANEL_OUTBOUND_PROXY);
    } catch {
      throw new Error('PANEL_OUTBOUND_PROXY is not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('PANEL_OUTBOUND_PROXY must be an http:// or https:// URL');
    }
  }

  const result: Env = {
    PANEL_MASTER_KEY: raw.PANEL_MASTER_KEY,
    PANEL_TRUST_PROXY: trustProxy,
    PANEL_DATA_DIR: dataDir,
    PORT: port,
    PANEL_NOTIFY_INCLUDE_LINKS:
      raw.PANEL_NOTIFY_INCLUDE_LINKS === 'true' || raw.PANEL_NOTIFY_INCLUDE_LINKS === '1',
    PANEL_NOTIFY_LOCALE: raw.PANEL_NOTIFY_LOCALE ?? 'en',
    PANEL_WATCHDOG_ENABLED:
      raw.PANEL_WATCHDOG_ENABLED === undefined
        ? true
        : raw.PANEL_WATCHDOG_ENABLED === 'true' || raw.PANEL_WATCHDOG_ENABLED === '1',
    PANEL_WATCHDOG_MEMORY_PERCENT: parsePercent(
      'PANEL_WATCHDOG_MEMORY_PERCENT',
      raw.PANEL_WATCHDOG_MEMORY_PERCENT,
      85,
    ),
    PANEL_WATCHDOG_DISK_PERCENT: parsePercent(
      'PANEL_WATCHDOG_DISK_PERCENT',
      raw.PANEL_WATCHDOG_DISK_PERCENT,
      80,
    ),
    NODE_ENV: raw.NODE_ENV ?? 'development',
  };

  if (raw.PANEL_ADMIN_USERNAME !== undefined) {
    result.PANEL_ADMIN_USERNAME = raw.PANEL_ADMIN_USERNAME;
  }
  if (raw.PANEL_ADMIN_PASSWORD !== undefined) {
    result.PANEL_ADMIN_PASSWORD = raw.PANEL_ADMIN_PASSWORD;
  }
  if (raw.PANEL_BASE_PATH !== undefined) {
    result.PANEL_BASE_PATH = raw.PANEL_BASE_PATH;
  }
  if (raw.PANEL_PUBLIC_URL !== undefined) {
    result.PANEL_PUBLIC_URL = raw.PANEL_PUBLIC_URL;
  }
  if (raw.RAILWAY_PUBLIC_DOMAIN !== undefined) {
    result.RAILWAY_PUBLIC_DOMAIN = raw.RAILWAY_PUBLIC_DOMAIN;
  }
  if (raw.PANEL_LISTEN_HOST !== undefined) {
    result.PANEL_LISTEN_HOST = raw.PANEL_LISTEN_HOST;
  }
  if (raw.PANEL_IN_CONTAINER !== undefined) {
    result.PANEL_IN_CONTAINER = raw.PANEL_IN_CONTAINER;
  }
  if (raw.PANEL_OUTBOUND_PROXY !== undefined && raw.PANEL_OUTBOUND_PROXY.length > 0) {
    result.PANEL_OUTBOUND_PROXY = raw.PANEL_OUTBOUND_PROXY;
  }

  return result;
}
