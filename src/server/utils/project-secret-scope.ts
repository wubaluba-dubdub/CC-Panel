import { segmentedAad } from '../crypto.js';

/**
 * The canonical secret scope and the AAD bindings for a project's secrets
 * (M2.2A contract only — nothing stores or reads a project secret yet).
 *
 * Identity is the project uuid, never the slug: renaming a project must not
 * move its secrets or break its ciphertext, so neither the scope nor either
 * AAD takes the slug as an input. The scope string `project:<uuid>` is storage
 * addressing (the `secrets.scope` value); the AAD builders are the byte-exact
 * binding a payload is authenticated under. Related, but not interchangeable:
 * the hook-token AAD spells the scope as two separate segments so that no
 * segment ever contains the `:` separator.
 */

/** `project` — the one scope prefix this module constructs or accepts. */
export const PROJECT_SECRET_SCOPE_PREFIX = 'project';

/**
 * The exact uuid grammar: lowercase hex, canonical 8-4-4-4-12 — which
 * `randomUUID()` output always satisfies. Uppercase is noncanonical and
 * rejected rather than folded: the uuid is identity, and a second spelling of
 * the same id would be a second row with ciphertext bound under different
 * bytes. Exported so tests pin the pattern itself, not a clone.
 */
export const PROJECT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The future secret names, fixed the way `telegram-config.ts` fixes its two. */
export const PROJECT_API_KEY_NAME = 'api_key';
export const PROJECT_HOOK_TOKEN_NAME = 'hook_token';

export class InvalidProjectSecretScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProjectSecretScopeError';
  }
}

/** A bare project uuid, or throws — the one validation every entry point below shares. */
function requireProjectUuid(uuid: string): string {
  if (typeof uuid !== 'string' || !PROJECT_UUID_PATTERN.test(uuid)) {
    throw new InvalidProjectSecretScopeError(
      `project uuid must be canonical lowercase hex 8-4-4-4-12: ${JSON.stringify(uuid)}`,
    );
  }
  return uuid;
}

/** The canonical scope for a project: `project:<uuid>`. Validates before interpolating. */
export function projectSecretScope(uuid: string): string {
  return `${PROJECT_SECRET_SCOPE_PREFIX}:${requireProjectUuid(uuid)}`;
}

/**
 * The uuid from a `project:<uuid>` scope, or throws
 * {@link InvalidProjectSecretScopeError}. Exactly one prefix, one canonical
 * uuid, and nothing else: no extra colon, trailing material, whitespace,
 * braces, slug, or path.
 */
export function parseProjectSecretScope(scope: string): string {
  if (typeof scope !== 'string') {
    throw new InvalidProjectSecretScopeError('project secret scope must be a string');
  }
  const parts = scope.split(':');
  if (parts.length !== 2 || parts[0] !== PROJECT_SECRET_SCOPE_PREFIX) {
    throw new InvalidProjectSecretScopeError(
      `scope must be exactly '${PROJECT_SECRET_SCOPE_PREFIX}:<uuid>' ` +
        `(one prefix, one canonical uuid, nothing further): ${JSON.stringify(scope)}`,
    );
  }
  return requireProjectUuid(parts[1] ?? '');
}

/**
 * The AAD a future `projects`-row api-key payload is bound to:
 * `projects:<uuid>:api_key` — three segments, the `columnAad` shape.
 */
export function projectApiKeyAad(uuid: string): string {
  return segmentedAad('projects', requireProjectUuid(uuid), PROJECT_API_KEY_NAME);
}

/**
 * The AAD a future `secrets` row `(project:<uuid>, hook_token)` is bound to:
 * `secrets:project:<uuid>:hook_token` — four segments, each colon-free, so the
 * scope's own colon is never smuggled inside one segment. Byte-equal to what
 * the repository's v2 path builds for that row, pinned by test.
 */
export function projectHookTokenAad(uuid: string): string {
  return segmentedAad(
    'secrets',
    PROJECT_SECRET_SCOPE_PREFIX,
    requireProjectUuid(uuid),
    PROJECT_HOOK_TOKEN_NAME,
  );
}
