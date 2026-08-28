import { z } from 'zod';

const WEAK_PASSWORDS = [
  'password123456',
  'admin123456789',
  'letmein1234567',
  'welcome1234567',
  'monkey12345678',
  'master12345678',
  'qwerty12345678',
  'abc123456789ab',
  'password1234567',
  'changeme123456',
];

const envSchema = z.object({
  PANEL_MASTER_KEY: z.string().min(1, 'PANEL_MASTER_KEY is required'),
  PANEL_ADMIN_USERNAME: z.string().min(1, 'PANEL_ADMIN_USERNAME is required'),
  PANEL_ADMIN_PASSWORD: z.string().min(12, 'PANEL_ADMIN_PASSWORD must be at least 12 characters'),
  PANEL_BASE_PATH: z.string().optional(),
  PANEL_TRUST_PROXY: z.string().optional(),
  PANEL_DATA_DIR: z.string().optional(),
  PORT: z.string().optional(),
  NODE_ENV: z.string().optional(),
});

export interface Env {
  PANEL_MASTER_KEY: string;
  PANEL_ADMIN_USERNAME: string;
  PANEL_ADMIN_PASSWORD: string;
  PANEL_BASE_PATH?: string;
  PANEL_TRUST_PROXY: boolean;
  PANEL_DATA_DIR: string;
  PORT: number;
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
  if (WEAK_PASSWORDS.includes(raw.PANEL_ADMIN_PASSWORD.toLowerCase())) {
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
    PANEL_ADMIN_USERNAME: raw.PANEL_ADMIN_USERNAME,
    PANEL_ADMIN_PASSWORD: raw.PANEL_ADMIN_PASSWORD,
    PANEL_TRUST_PROXY: trustProxy,
    PANEL_DATA_DIR: dataDir,
    PORT: port,
    NODE_ENV: raw.NODE_ENV ?? 'development',
  };

  if (raw.PANEL_BASE_PATH !== undefined) {
    result.PANEL_BASE_PATH = raw.PANEL_BASE_PATH;
  }

  return result;
}
