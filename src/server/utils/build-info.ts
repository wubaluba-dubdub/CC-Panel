/**
 * Build identity: a short commit SHA from a documented environment variable, or
 * null when no source is available.
 *
 * Railway exposes `RAILWAY_GIT_COMMIT_SHA` (documented) and
 * `RAILWAY_DEPLOYMENT_ID` (documented) to the runtime. `GITHUB_SHA` is
 * documented for GitHub Actions but sometimes forwarded by Railway too. When
 * none are present (plain `docker build` locally, or any environment without
 * these variables), the identity is null — never a generated timestamp, which
 * would be process identity, not build identity.
 *
 * The value is computed once at startup and never changes. It is exposed only
 * behind authentication (on `GET /api/auth/me`) and never on `/healthz`, never
 * in the pre-login shell, never in a response header, and never in an outbound
 * notification.
 */

export interface BuildIdentity {
  /** A 7-character commit SHA, or null when no documented source is available. */
  readonly buildId: string | null;
  /** Whether a SHA was found in a documented env var. */
  readonly source: 'env' | 'none';
}

const SHA_LENGTH = 7;

/**
 * The three documented environment variables that may carry a commit SHA.
 *
 * `RAILWAY_GIT_COMMIT_SHA` is the primary; `RAILWAY_DEPLOYMENT_ID` is a
 * secondary that Railway always sets; `GITHUB_SHA` may be forwarded.
 *
 * `VERCEL_GIT_COMMIT_SHA` is excluded: it is not documented for Railway and
 * not a documented source for this repository's build/deploy path.
 */
const SHA_ENV_VARS = [
  'RAILWAY_GIT_COMMIT_SHA',
  'RAILWAY_DEPLOYMENT_ID',
  'GITHUB_SHA',
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

/**
 * Resolved once, at import time. Reads environment variables, which are
 * immutable after process start. No timestamp fallback: a generated value
 * would be process identity, not build identity.
 */
function resolveBuildIdentity(): BuildIdentity {
  const sha = readShaFromEnv();
  if (sha !== null) {
    return { buildId: sha, source: 'env' };
  }

  return { buildId: null, source: 'none' };
}

export const BUILD_IDENTITY: BuildIdentity = resolveBuildIdentity();
