import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { getDb } from '../db.js';
import { type Clock, isoNow, systemClock } from '../utils/clock.js';

/**
 * The slug pattern: 2–40 ASCII lowercase alphanumeric characters, with
 * hyphens allowed in the middle. Anchored, so the full string must match.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

const MAX_SLUG_LENGTH = 40;

/**
 * Explicit projection for every repository SELECT.
 *
 * The seven M2.8 import columns (origin, origin_ref, origin_at,
 * source_install_id, review_state, reviewed_at, artefacts_json) exist on the
 * table but must never enter a SELECT projection, INSERT list, UPDATE list,
 * RETURNING clause, or this row type: `SELECT *` would silently read them.
 * A TypeScript field on {@link ProjectRow} is a schema declaration only when
 * the projection actually returns it — so this type names exactly the columns
 * above, and nothing else.
 */
const PROJECT_COLUMNS =
  'id, uuid, slug, slug_normalized, isolated_settings, created_at, updated_at';

export interface ProjectRow {
  id: number;
  uuid: string;
  slug: string;
  slug_normalized: string;
  isolated_settings: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectRecord {
  id: number;
  uuid: string;
  slug: string;
  /** True when the requested slug collided with an existing one and was suffixed. */
  renamed: boolean;
  isolatedSettings: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectResult {
  project: ProjectRecord;
  /** True when the slug was suffixed to resolve a collision. */
  renamed: boolean;
}

export class SlugError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlugError';
  }
}

export class ProjectNotFoundError extends Error {
  constructor(identifier: string) {
    super(`project not found: ${identifier}`);
    this.name = 'ProjectNotFoundError';
  }
}

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    uuid: row.uuid,
    slug: row.slug,
    renamed: false,
    isolatedSettings: row.isolated_settings === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * NFC-normalise and lowercase a slug input.
 *
 * The slug pattern restricts input to `[a-z0-9-]` (all ASCII), so `toLowerCase()`
 * is equivalent to Unicode case folding for the valid set. NFC is applied anyway
 * as a defence-in-depth: a future code path that passes a precomposed or
 * decomposed string through this function produces the same normalised form, and
 * the generated column in the database is a second safety net.
 *
 * Returns the normalised slug, which may differ from the input only in case.
 * Throws {@link SlugError} when the result does not match the pattern.
 */
export function normalizeSlug(input: string): string {
  const normalised = input.normalize('NFC').toLowerCase();
  if (!SLUG_PATTERN.test(normalised)) {
    throw new SlugError(
      `invalid slug: must match ${SLUG_PATTERN.source} (2–40 lowercase alphanumeric characters, hyphens in the middle)`,
    );
  }
  return normalised;
}

/**
 * Repository for project identity and metadata.
 *
 * No filesystem access — the service that creates directories is M2.3's
 * responsibility and calls this repository. UUIDs are generated with
 * `crypto.randomUUID()`.
 */
export class ProjectsRepository {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(opts: { db?: Database; clock?: Clock } = {}) {
    this.#db = opts.db ?? getDb();
    this.#clock = opts.clock ?? systemClock;
  }

  /**
   * Creates a project, handling slug collisions with a `-2` / `-3` suffix.
   *
   * The caller receives both the stored row and a `renamed` flag. A silent
   * rename is a defect: the caller must know that the slug they requested was
   * not the one stored.
   *
   * The suffix must not push the slug past 40 characters. When the stem is
   * already at the limit, the suffix is appended by truncating the stem first.
   * If truncation would leave fewer than 2 characters, the creation is refused
   * rather than producing an invalid slug.
   *
   * `uuid` is optional so the project-store service can create the on-disk
   * layout first (under a uuid it chose) and commit the row last. When omitted,
   * a fresh `crypto.randomUUID()` is generated here.
   */
  create(input: {
    slug: string;
    isolatedSettings?: boolean;
    uuid?: string;
  }): CreateProjectResult {
    const baseSlug = normalizeSlug(input.slug);
    const now = isoNow(this.#clock);
    const uuid = input.uuid ?? randomUUID();

    // Try the base slug first, then -2, -3, ... until we find a free one.
    let slug = baseSlug;
    let renamed = false;
    let attempt = 0;

    const insert = this.#db.prepare(
      `INSERT INTO projects (uuid, slug, isolated_settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );

    while (true) {
      attempt += 1;
      const suffix = attempt === 1 ? '' : `-${attempt}`;
      slug = baseSlug.length + suffix.length > MAX_SLUG_LENGTH
        ? baseSlug.slice(0, MAX_SLUG_LENGTH - suffix.length) + suffix
        : baseSlug + suffix;

      // Validate the suffixed slug. The stem was valid; the suffix is `-N`
      // which is valid in the middle. The only failure mode is truncation
      // leaving a trailing hyphen, which we handle by refusing.
      if (suffix !== '' && !SLUG_PATTERN.test(slug)) {
        throw new SlugError(
          `slug collision cannot be resolved: stem "${baseSlug}" is too long for a suffix`,
        );
      }

      try {
        insert.run(uuid, slug, input.isolatedSettings ? 1 : 0, now, now);
        renamed = attempt > 1;
        break;
      } catch (err: unknown) {
        // SQLite UNIQUE constraint violation on slug_normalized
        if (
          err instanceof Error &&
          err.message.includes('UNIQUE constraint failed: projects.slug_normalized')
        ) {
          continue;
        }
        throw err;
      }
    }

    const row = this.#db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE uuid = ?`)
      .get(uuid) as ProjectRow;
    const record = toRecord(row);
    record.renamed = renamed;
    return { project: record, renamed };
  }

  getByUuid(uuid: string): ProjectRecord | null {
    const row = this.#db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE uuid = ?`)
      .get(uuid) as ProjectRow | undefined;
    return row ? toRecord(row) : null;
  }

  getBySlug(slug: string): ProjectRecord | null {
    const normalised = normalizeSlug(slug);
    const row = this.#db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE slug_normalized = ?`)
      .get(normalised) as ProjectRow | undefined;
    return row ? toRecord(row) : null;
  }

  list(): ProjectRecord[] {
    const rows = this.#db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY created_at ASC, id ASC`)
      .all() as ProjectRow[];
    return rows.map(toRecord);
  }

  /**
   * Renames a project's slug. The UUID is unchanged, the new slug is normalised,
   * and collisions are resolved with the same suffix logic as {@link create}.
   *
   * Returns the updated record with a `renamed` flag if a suffix was added.
   */
  rename(uuid: string, newSlug: string): ProjectRecord {
    const existing = this.getByUuid(uuid);
    if (!existing) throw new ProjectNotFoundError(uuid);

    const baseSlug = normalizeSlug(newSlug);
    const now = isoNow(this.#clock);

    // Try the base slug first, then -2, -3, ...
    let slug = baseSlug;
    let renamed = false;
    let attempt = 0;

    const update = this.#db.prepare(
      'UPDATE projects SET slug = ?, updated_at = ? WHERE uuid = ?',
    );

    while (true) {
      attempt += 1;
      const suffix = attempt === 1 ? '' : `-${attempt}`;
      slug = baseSlug.length + suffix.length > MAX_SLUG_LENGTH
        ? baseSlug.slice(0, MAX_SLUG_LENGTH - suffix.length) + suffix
        : baseSlug + suffix;

      if (suffix !== '' && !SLUG_PATTERN.test(slug)) {
        throw new SlugError(
          `slug collision cannot be resolved: stem "${baseSlug}" is too long for a suffix`,
        );
      }

      try {
        const result = update.run(slug, now, uuid);
        if (result.changes === 0) throw new ProjectNotFoundError(uuid);
        renamed = attempt > 1;
        break;
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.message.includes('UNIQUE constraint failed: projects.slug_normalized')
        ) {
          continue;
        }
        throw err;
      }
    }

    const row = this.#db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE uuid = ?`)
      .get(uuid) as ProjectRow;
    const record = toRecord(row);
    record.renamed = renamed;
    return record;
  }

  /**
   * Deletes a project row. Returns true when a row was removed.
   *
   * No filesystem access — M2.3's service handles directory cleanup.
   */
  delete(uuid: string): boolean {
    const result = this.#db.prepare('DELETE FROM projects WHERE uuid = ?').run(uuid);
    return result.changes > 0;
  }
}
