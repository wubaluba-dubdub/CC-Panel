import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { type Clock, isoNow, systemClock } from '../utils/clock.js';
import { SLUG_PATTERN, canonicalizeSlug } from '../utils/project-slug.js';

/**
 * Row-level storage for projects (M2.2A, data layer only). Identity is the `uuid`;
 * the slug is a mutable label — rename rewrites `slug` and nothing else, because
 * nothing durable is keyed on the slug. Filesystem layout and deletion are chunk 4.
 * Every write canonicalises its slug through `canonicalizeSlug` before SQL, which
 * is what makes the schema's byte-wise UNIQUE(slug) mean "unique after NFC and case
 * folding". The seven import columns are deliberately absent from
 * {@link ProjectRecord}: migration 012 records that nothing reads them until M2.8.
 */
export interface ProjectRecord {
  id: number;
  uuid: string;
  slug: string;
  isolatedSettings: boolean;
  createdAt: string;
}

interface ProjectRow {
  id: number;
  uuid: string;
  slug: string;
  isolated_settings: number;
  created_at: string;
  origin: string | null;
  origin_ref: string | null;
  origin_at: string | null;
  source_install_id: string | null;
  review_state: string | null;
  reviewed_at: string | null;
  artefacts_json: string | null;
}

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    uuid: row.uuid,
    slug: row.slug,
    isolatedSettings: row.isolated_settings === 1,
    createdAt: row.created_at,
  };
}

export class ProjectNotFoundError extends Error {
  constructor(uuid: string) {
    super(`no project ${JSON.stringify(uuid)}`);
    this.name = 'ProjectNotFoundError';
  }
}

/** A slug could not be claimed, or the generated uuid already exists. The route
 * chunk maps this to a retry or a 409 — never to a silently different name. */
export class ProjectConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectConflictError';
  }
}

/** What a create or rename did to the requested slug. A silent rename is forbidden. */
export interface ProjectWriteResult {
  project: ProjectRecord;
  /** The canonical form of the request; `slugChanged` says the suffix rule fired. */
  requestedSlug: string;
  finalSlug: string;
  slugChanged: boolean;
}

export class ProjectsRepository {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(opts: { db?: Database; clock?: Clock } = {}) {
    this.#db = opts.db ?? getDb();
    this.#clock = opts.clock ?? systemClock;
  }

  create(opts: { slug: string; isolatedSettings?: boolean }): ProjectWriteResult {
    const requestedSlug = canonicalizeSlug(opts.slug);
    const uuid = randomUUID();
    const createdAt = isoNow(this.#clock);

    const txn = this.#db.transaction((slug: string): ProjectRow => {
      this.#db
        .prepare('INSERT INTO projects (uuid, slug, isolated_settings, created_at) VALUES (?, ?, ?, ?)')
        .run(uuid, slug, opts.isolatedSettings === true ? 1 : 0, createdAt);
      return this.#db.prepare('SELECT * FROM projects WHERE uuid = ?').get(uuid) as ProjectRow;
    });

    return this.#claim(requestedSlug, null, txn);
  }

  /** One row by uuid — the only identity lookup. A slug or path is not an identity. */
  get(uuid: string): ProjectRecord | null {
    const row = this.#db.prepare('SELECT * FROM projects WHERE uuid = ?').get(uuid) as
      | ProjectRow
      | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /** Deterministic: `created_at` (ISO-8601 Z sorts chronologically), then `id`. */
  list(): ProjectRecord[] {
    const rows = this.#db.prepare('SELECT * FROM projects ORDER BY created_at, id').all() as ProjectRow[];
    return rows.map(toRecord);
  }

  rename(uuid: string, slug: string): ProjectWriteResult {
    const requestedSlug = canonicalizeSlug(slug);
    if (this.get(uuid) === null) throw new ProjectNotFoundError(uuid);

    const txn = this.#db.transaction((finalSlug: string): ProjectRow => {
      const result = this.#db
        .prepare('UPDATE projects SET slug = ? WHERE uuid = ?')
        .run(finalSlug, uuid);
      if (result.changes === 0) throw new ProjectNotFoundError(uuid);
      return this.#db.prepare('SELECT * FROM projects WHERE uuid = ?').get(uuid) as ProjectRow;
    });

    return this.#claim(requestedSlug, uuid, txn);
  }

  /**
   * Picks the slug and runs the write, retrying when another process took the
   * candidate between probe and insert (single-process everything is synchronous
   * and the loop runs once). `excludeUuid` is the row being renamed: its own slug
   * must not count as a collision, or renaming to itself → `alpha-2`.
   */
  #claim(
    requestedSlug: string,
    excludeUuid: string | null,
    txn: (slug: string) => ProjectRow,
  ): ProjectWriteResult {
    for (let attempt = 0; ; attempt++) {
      try {
        const finalSlug = this.#firstAvailable(requestedSlug, excludeUuid);
        const row = txn(finalSlug);
        return {
          project: toRecord(row),
          requestedSlug,
          finalSlug,
          slugChanged: finalSlug !== requestedSlug,
        };
      } catch (err) {
        if (err instanceof Error && err.message.includes('UNIQUE constraint failed: projects.uuid')) {
          throw new ProjectConflictError('generated project uuid already exists');
        }
        if (!(err instanceof Error && lostSlugRace(err))) throw err;
        if (attempt >= 4) {
          throw new ProjectConflictError(`slug contention near ${JSON.stringify(requestedSlug)}`);
        }
      }
    }
  }

  /** The requested slug, or the first free `-2`, `-3`, … — revalidating every candidate. */
  #firstAvailable(canonical: string, excludeUuid: string | null): string {
    if (!this.#taken(canonical, excludeUuid)) return canonical;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      let base = canonical;
      if (base.length + suffix.length > 40) base = base.slice(0, 40 - suffix.length);
      // A trailing hyphen on the shortened base would make `base--2`; trim it.
      while (base.length > 1 && base.endsWith('-')) base = base.slice(0, -1);
      const candidate = base + suffix;
      if (SLUG_PATTERN.test(candidate) && !this.#taken(candidate, excludeUuid)) return candidate;
    }
  }

  #taken(slug: string, excludeUuid: string | null): boolean {
    const row =
      excludeUuid === null
        ? this.#db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug)
        : this.#db.prepare('SELECT 1 FROM projects WHERE slug = ? AND uuid != ?').get(slug, excludeUuid);
    return row !== undefined;
  }
}

/** SQLite messages that mean "lost the race for this slug" or "lock contention". */
function lostSlugRace(err: Error): boolean {
  return (
    err.message.includes('UNIQUE constraint failed: projects.slug') ||
    err.message.includes('database is locked')
  );
}
