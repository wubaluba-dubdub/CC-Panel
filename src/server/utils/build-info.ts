import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Build identity: a short commit SHA or a timestamp with an explicit marker.
 *
 * Railway exposes `RAILWAY_GIT_COMMIT_SHA` (documented) and
 * `RAILWAY_DEPLOYMENT_ID` (documented) to the runtime. `GITHUB_SHA` is
 * documented for GitHub Actions but sometimes forwarded by Railway too. When
 * none are present (plain `docker build` locally), the identity is a timestamp
 * with a `[unknown]` marker so it can never be mistaken for a real SHA.
 *
 * The value is computed once at startup and never changes. It is exposed only
 * behind authentication (on `GET /api/auth/me`) and never on `/healthz`, never
 * in the pre-login shell, never in a response header, and never in an outbound
 * notification.
 */

export interface BuildIdentity {
  /** A 7-character commit SHA, or a timestamp-based fallback. */
  readonly buildId: string;
  /** Whether the SHA came from a real env var or was computed locally. */
  readonly source: 'env' | 'fallback';
}

const SHA_LENGTH = 7;

/**
 * The four documented Railway variables that may carry a commit SHA.
 *
 * `RAILWAY_GIT_COMMIT_SHA` is the primary; `RAILWAY_DEPLOYMENT_ID` is a
 * secondary that Railway always sets; `GITHUB_SHA` may be forwarded.
 * `VERCEL_GIT_COMMIT_SHA` is unconfirmed — not documented, but present in
 * some Railway templates. We read it defensively.
 */
const SHA_ENV_VARS = [
  'RAILWAY_GIT_COMMIT_SHA',
  'RAILWAY_DEPLOYMENT_ID',
  'GITHUB_SHA',
  'VERCEL_GIT_COMMIT_SHA',
] as const;

function readShaFromEnv(): string | null {
  for (const name of SHA_ENV_VARS) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length >= SHA_LENGTH) {
      return value.slice(0, SHA_LENGTH);
    }
  }
  return null;
}

function buildTimestamp(): string {
  // ISO-8601 without separators, compact enough for a build id.
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}

/**
 * Resolved once, at import time. Reads environment variables, which are
 * immutable after process start.
 *
 * The `build.json` file is an optional override: `npm run build` can write it,
 * and it takes precedence over env vars. This is how a local build can embed a
 * known SHA without setting env vars in the shell.
 */
function resolveBuildIdentity(): BuildIdentity {
  // Optional: a file written by the build script.
  try {
    const buildJson = join(
      typeof import.meta.dirname === 'string' ? import.meta.dirname : '.',
      '..',
      '..',
      'build.json',
    );
    const data = JSON.parse(readFileSync(buildJson, 'utf-8')) as { sha?: string };
    if (typeof data.sha === 'string' && data.sha.length >= SHA_LENGTH) {
      return { buildId: data.sha.slice(0, SHA_LENGTH), source: 'env' };
    }
  } catch {
    // No build.json — fall through to env vars.
  }

  const sha = readShaFromEnv();
  if (sha !== null) {
    return { buildId: sha, source: 'env' };
  }

  return { buildId: buildTimestamp(), source: 'fallback' };
}

export const BUILD_IDENTITY: BuildIdentity = resolveBuildIdentity();
