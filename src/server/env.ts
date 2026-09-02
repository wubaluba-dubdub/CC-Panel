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
  NODE_ENV: string;
}

export function loadEnv(): Env {
  const raw = envSchema.parse(process.env);

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

  const result: Env = {
    PANEL_MASTER_KEY: raw.PANEL_MASTER_KEY,
    PANEL_TRUST_PROXY: trustProxy,
    PANEL_DATA_DIR: dataDir,
    PORT: port,
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

  return result;
}
