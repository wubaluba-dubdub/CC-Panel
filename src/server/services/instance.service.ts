import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * `/data/config/instance.json` — the per-install facts that are not secrets and
 * not schema.
 *
 * `resolveBasePath()` in `app.ts` creates this file on first boot. This module
 * exists for the one operation that has to change it afterwards: regenerating the
 * base path.
 */
export interface InstanceConfig {
  basePath: string;
  installId: string;
  schemaVersion: number;
}

/** 22 base64url characters — 132 bits, the same shape first boot generates. */
export const BASE_PATH_LENGTH = 22;

export function generateBasePathValue(): string {
  return randomBytes(16).toString('base64url').slice(0, BASE_PATH_LENGTH);
}

function instanceFilePath(dataDir: string): string {
  return join(dataDir, 'config', 'instance.json');
}

export function readInstanceConfig(dataDir: string): InstanceConfig | null {
  const file = instanceFilePath(dataDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as InstanceConfig;
  } catch {
    return null;
  }
}

/**
 * Writes a fresh base path, preserving `installId`.
 *
 * The running server keeps serving the old prefix: it is baked into the route
 * mount and into the pre-routing gate, both fixed when the app was built. Live
 * re-mounting would mean tearing down and rebuilding the router while requests
 * are in flight, which is a much larger risk than telling the operator to
 * restart. The response says so explicitly rather than implying the change is
 * already in effect.
 */
export function regenerateBasePath(dataDir: string): string {
  const configDir = join(dataDir, 'config');
  mkdirSync(configDir, { recursive: true });

  const existing = readInstanceConfig(dataDir);
  const basePath = generateBasePathValue();

  writeFileSync(
    instanceFilePath(dataDir),
    JSON.stringify({
      basePath,
      installId: existing?.installId ?? randomBytes(16).toString('hex'),
      schemaVersion: existing?.schemaVersion ?? 1,
    }),
  );

  return basePath;
}
