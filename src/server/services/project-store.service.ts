import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiskReading } from './resources.service.js';
import { readDisk } from './resources.service.js';
import {
  ProjectsRepository,
  ProjectNotFoundError,
  normalizeSlug,
  type ProjectRecord,
} from './projects.service.js';
import { SecretsRepository } from './secrets.service.js';
import { type Clock, isoFrom, systemClock } from '../utils/clock.js';

/**
 * The project service: on-disk layout, atomic creation, the boot sweep,
 * deletion, the per-project secret scope, and the disk guard.
 *
 * No routes and no UI — those are prompts 4 and 5. This module owns the
 * filesystem contract and the failure behaviour around it.
 *
 * ── Why staging is a sibling of `projects/`, not inside it ──────────────────
 *
 * Two reasons, both load-bearing. The boot sweep walks a prefix next to
 * `projects/`, so a staging directory *inside* `projects/` would be mistaken
 * for a project (and, worse, for a promoted one). And `rename(2)` stays atomic
 * only on one filesystem — a sibling under the same parent guarantees that.
 *
 * ── Audit is returned, not written ──────────────────────────────────────────
 *
 * Prompt 4 registers the audit events and notification rules. This prompt's
 * service therefore returns the facts a route layer will audit (or, for the
 * boot sweep, hands them to an injected log sink). Registering an event here
 * would require touching `AUDIT_EVENTS` and `notification-rules.ts` in the
 * wrong commit.
 */

/** Directory-mode bits for every directory this service creates. */
const DIR_MODE = 0o700;
/** File-mode bits for every file this service creates. Never an execute bit. */
const FILE_MODE = 0o600;

/**
 * Prefix of a staging directory, as a sibling of `projects/`.
 *
 * Chosen to be unambiguous against a project uuid (uuids are hex + hyphens)
 * and against the import staging under `projects/.import-*` (M2.6) — this is
 * outside `projects/` entirely.
 */
export const STAGING_PREFIX = '.project-stage-';

/**
 * Prefix of a quarantine directory for a promoted tree whose database commit
 * failed. Visible to an operator listing the data directory; never silently
 * deleted by the sweep (the sweep only looks at staging).
 */
export const ORPHAN_PREFIX = '.project-orphan-';

/**
 * How old a staging directory must be before the boot sweep removes it.
 *
 * Age guard so a concurrent creation from another process (or a slow disk) is
 * never swept mid-flight. One minute is far longer than any create path needs
 * (mkdir + a few writes + rename) and far shorter than "operator notices".
 * The sweep runs at boot, before the server accepts requests, so the only
 * race it has to lose is against a *previous* process that is somehow still
 * alive — which a minute comfortably covers.
 */
export const STAGING_MIN_AGE_MS = 60_000;

/** Schema version written into `project.json`. */
export const PROJECT_JSON_VERSION = 1;

/**
 * Key names that must never appear in `project.json`. The denylist the
 * prompt requires a test over — a credential-shaped key is how a file that is
 * supposed to be metadata becomes a leak.
 */
export const PROJECT_JSON_DENYLIST = [
  'api_key',
  'apiKey',
  'token',
  'secret',
  'password',
  'credential',
  'credentials',
  'hook_token',
  'hookToken',
  'authorization',
  'private_key',
  'privateKey',
] as const;

export class DiskGuardRefusedError extends Error {
  constructor() {
    // Generic on purpose: no path from /data, no byte count, no base path.
    super('insufficient disk space to create a project');
    this.name = 'DiskGuardRefusedError';
  }
}

export class ProjectStoreError extends Error {
  readonly phase: 'staging' | 'rename' | 'database' | 'delete';

  constructor(phase: ProjectStoreError['phase'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProjectStoreError';
    this.phase = phase;
  }
}

/**
 * One project's `project.json`. Never a credential — the denylist test
 * enforces that, and the shape is deliberately closed.
 */
export interface ProjectJson {
  uuid: string;
  slug: string;
  createdAt: string;
  schemaVersion: number;
  isolatedSettings: boolean;
}

/** What a successful create leaves behind, for the route layer to audit. */
export interface CreateResult {
  project: ProjectRecord;
  /** True when the requested slug collided and was suffixed. */
  renamed: boolean;
}

/** What the boot sweep removed (and nothing else). */
export interface SweepResult {
  removed: string[];
}

/**
 * The per-project secret scope, `project:<uuid>`.
 *
 * Mirrors `columnAad()`'s rejection of `:` inside a component: a colon in the
 * uuid would make `project:<uuid>` ambiguous against a future scope shape and
 * would break the injectivity `columnAad('secrets', scope, name)` relies on.
 */
export function projectScope(uuid: string): string {
  if (uuid.length === 0) throw new Error('project scope component must not be empty');
  if (uuid.includes(':')) {
    throw new Error(`project scope component must not contain ':' (got ${JSON.stringify(uuid)})`);
  }
  return `project:${uuid}`;
}

function assertUuidSegment(uuid: string): void {
  if (uuid.includes('/') || uuid.includes('\0') || uuid === '.' || uuid === '..') {
    throw new Error('invalid project uuid segment');
  }
}

export interface ProjectStoreOptions {
  /** The panel data directory (production: `/data`). Never logged. */
  dataDir: string;
  db?: Database;
  clock?: Clock;
  projects?: ProjectsRepository;
  secrets?: SecretsRepository;
  /**
   * Disk guard inputs. `thresholdPercent` returns the watchdog's disk warning
   * threshold, or `null` when the rule is disabled. `readDisk` is the
   * injectable fake sampler for tests.
   */
  disk?: {
    thresholdPercent: () => number | null;
    readDisk?: (dataDir: string) => DiskReading;
  };
  log?: (event: Record<string, unknown> & { message: string }) => void;
  /**
   * Test seams for the three create failure paths. Production passes none.
   * Each, when true, makes the named step fail *as if the operation itself*
   * failed — so the test exercises the real cleanup path rather than a mock.
   */
  failStaging?: boolean;
  failRename?: boolean;
  failDatabase?: boolean;
  /**
   * Test seam: after which delete step should the process "crash" (throw)
   * once that step has fully completed. Production passes none.
   */
  crashAfter?: 'db' | 'fs';
}

export class ProjectStoreService {
  readonly #dataDir: string;
  readonly #projectsDir: string;
  readonly #clock: Clock;
  readonly #projects: ProjectsRepository;
  readonly #secrets: SecretsRepository | null;
  readonly #disk: ProjectStoreOptions['disk'];
  readonly #log: (event: Record<string, unknown> & { message: string }) => void;
  readonly #failStaging: boolean;
  readonly #failRename: boolean;
  readonly #failDatabase: boolean;
  readonly #crashAfter: 'db' | 'fs' | undefined;

  constructor(opts: ProjectStoreOptions) {
    this.#dataDir = opts.dataDir;
    this.#projectsDir = join(opts.dataDir, 'projects');
    this.#clock = opts.clock ?? systemClock;
    const db = opts.db;
    this.#projects = opts.projects ?? new ProjectsRepository({ ...(db ? { db } : {}), clock: this.#clock });
    this.#secrets = opts.secrets ?? new SecretsRepository({ ...(db ? { db } : {}), clock: this.#clock });
    this.#disk = opts.disk;
    this.#log = opts.log ?? ((): void => {});
    this.#failStaging = opts.failStaging ?? false;
    this.#failRename = opts.failRename ?? false;
    this.#failDatabase = opts.failDatabase ?? false;
    this.#crashAfter = opts.crashAfter;
  }

  /** Absolute path of a project directory. For tests and for the report's tree. */
  projectDir(uuid: string): string {
    assertUuidSegment(uuid);
    return join(this.#projectsDir, uuid);
  }

  workspaceDir(uuid: string): string {
    return join(this.projectDir(uuid), 'workspace');
  }

  claudeHomeDir(uuid: string): string {
    return join(this.projectDir(uuid), 'claude-home');
  }

  projectJsonPath(uuid: string): string {
    return join(this.projectDir(uuid), 'project.json');
  }

  /**
   * Refuses creation above the watchdog's disk warning threshold.
   *
   * Threshold comes from the watchdog (via `disk.thresholdPercent`), never a
   * parallel constant. `null` means the rule is disabled — the memory-limit
   * precedent: a disabled rule never defaults to refusing (or to allowing by
   * silently inventing a number). An unreadable volume is the same state:
   * without a figure there is nothing to compare, so the guard is disabled
   * rather than fail-closed on a missing `statfs`.
   *
   * Returns `{ allowed: false }` only when a real reading is at or above the
   * threshold.
   */
  checkDisk(): { allowed: boolean; reason: 'below_threshold' | 'above_threshold' | 'disabled' } {
    const threshold = this.#disk?.thresholdPercent?.() ?? null;
    if (threshold === null) return { allowed: true, reason: 'disabled' };

    const reader = this.#disk?.readDisk ?? readDisk;
    const reading = reader(this.#dataDir);
    if (reading.totalBytes <= 0) return { allowed: true, reason: 'disabled' };

    const usedFraction = (reading.totalBytes - reading.availableBytes) / reading.totalBytes;
    const thresholdFraction = threshold / 100;
    if (usedFraction >= thresholdFraction) {
      return { allowed: false, reason: 'above_threshold' };
    }
    return { allowed: true, reason: 'below_threshold' };
  }

  /**
   * Creates a project: staging sibling → rename into `projects/<uuid>` →
   * database transaction commits last.
   *
   * Failure behaviour (stated in the report):
   * - staging fails → nothing on disk, nothing in the database;
   * - rename fails  → staging removed, nothing in the database;
   * - database commit fails → the promoted directory is **quarantined** to
   *   `<data>/.project-orphan-<uuid>` and a log line names the quarantine
   *   (uuid only, never the base path). Quarantine rather than revert: a
   *   rename-back can itself fail (ENOSPC, a concurrent actor), leaving a
   *   half-known state; moving the tree aside is one atomic rename that always
   *   leaves `projects/` free of rowless directories, and the operator finds
   *   orphans by listing `.*project-orphan-*` beside `projects/`.
   */
  create(input: {
    slug: string;
    isolatedSettings?: boolean;
    uuid?: string;
  }): CreateResult {
    const guard = this.checkDisk();
    if (!guard.allowed) throw new DiskGuardRefusedError();

    // Validate the slug before touching the filesystem.
    const slug = normalizeSlug(input.slug);
    const uuid = input.uuid ?? randomUUID();
    assertUuidSegment(uuid);

    const staging = join(this.#dataDir, `${STAGING_PREFIX}${uuid}`);
    const target = this.projectDir(uuid);

    // ── 1. Staging ──────────────────────────────────────────────────────────
    try {
      if (this.#failStaging) throw new Error('injected staging failure');
      this.#buildTree(staging, {
        uuid,
        slug,
        createdAt: isoFrom(this.#clock.now()),
        schemaVersion: PROJECT_JSON_VERSION,
        isolatedSettings: input.isolatedSettings === true,
      });
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw new ProjectStoreError('staging', 'staging failed', { cause: err });
    }

    // ── 2. Rename into place (same filesystem → atomic) ─────────────────────
    try {
      if (this.#failRename) throw new Error('injected rename failure');
      if (existsSync(target)) {
        throw new Error('target project directory already exists');
      }
      renameSync(staging, target);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw new ProjectStoreError('rename', 'rename into place failed', { cause: err });
    }

    // ── 3. Database transaction commits LAST ────────────────────────────────
    try {
      if (this.#failDatabase) throw new Error('injected database failure');
      const result = this.#projects.create({
        slug,
        uuid,
        ...(input.isolatedSettings !== undefined
          ? { isolatedSettings: input.isolatedSettings }
          : {}),
      });
      return { project: result.project, renamed: result.renamed };
    } catch (err) {
      // Quarantine the promoted tree. One rename; never a recursive delete of a
      // tree we might still need to inspect.
      const orphan = join(this.#dataDir, `${ORPHAN_PREFIX}${uuid}`);
      try {
        rmSync(orphan, { recursive: true, force: true });
        renameSync(target, orphan);
      } catch {
        // If even the quarantine rename fails, leave the directory where it is
        // and say so — an unmovable orphan is still an orphan the operator can
        // see under projects/.
        this.#log({
          message: 'project database commit failed and quarantine also failed',
          uuid,
          phase: 'database',
        });
      }
      this.#log({
        message: 'project database commit failed; promoted directory quarantined',
        uuid,
        phase: 'database',
        quarantined: existsSync(orphan),
      });
      throw new ProjectStoreError('database', 'database commit failed', { cause: err });
    }
  }

  /**
   * Deletes a project: database transaction first (row + secrets), then the
   * filesystem. Audit rows are append-only and are never touched.
   *
   * Order and crash residual:
   * - **after the database step**: row and `project:<uuid>` secrets are gone;
   *   `projects/<uuid>/` still exists. Invisible in the UI; the next boot can
   *   ignore it (it is inert bytes) or an operator can remove it. Chosen
   *   because the panel's view of the world is the database — once the row is
   *   gone the project is deleted from the operator's perspective, and a
   *   crash cannot resurrect a half-deleted credential.
   * - **after the filesystem step**: everything this prompt deletes is gone.
   *
   * Future refusal check: the "refuse while a session is attached" guard (M3,
   * terminals) must run at the top of this method, **before** the database
   * transaction — before any mutation. There is nothing to refuse for yet.
   */
  delete(uuid: string): { rowDeleted: boolean; secretsDeleted: number; dirRemoved: boolean } {
    const existing = this.#projects.getByUuid(uuid);
    if (!existing) throw new ProjectNotFoundError(uuid);

    // FUTURE (M3): refuse while a terminal session is attached. Check goes HERE.

    const scope = projectScope(uuid);
    let secretsDeleted = 0;
    let rowDeleted = false;

    // Step 1: database. Secrets first, then the row — both synchronous
    // better-sqlite3 calls. A crash between them leaves a rowless secret
    // under a scope nothing references; a retry of delete finishes it.
    // Deleting the row second means a crash after secrets leaves the project
    // still visible (with no credentials) rather than invisible with live
    // credentials, which is the safer residual.
    secretsDeleted = this.#secrets ? this.#secrets.deleteScope(scope) : 0;
    rowDeleted = this.#projects.delete(uuid);

    if (this.#crashAfter === 'db') {
      throw new ProjectStoreError('delete', 'simulated crash after database step');
    }

    // Step 2: filesystem. `rmSync` of the project directory removes workspace/,
    // claude-home/, project.json and the directory itself in one call.
    const dir = this.projectDir(uuid);
    let dirRemoved = false;
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      dirRemoved = true;
    }

    if (this.#crashAfter === 'fs') {
      throw new ProjectStoreError('delete', 'simulated crash after filesystem step');
    }

    return { rowDeleted, secretsDeleted, dirRemoved };
  }

  /**
   * Sweeps abandoned staging directories at boot.
   *
   * **What it sees:** `<data>/.project-stage-*` whose mtime is older than
   * {@link STAGING_MIN_AGE_MS}.
   *
   * **What it does not see:** a promoted project directory that has no
   * database row (an orphan from a crash between rename and commit). That
   * lives under `projects/<uuid>/`, not under the staging prefix. Orphans are
   * either quarantined at create-fail time (visible as `.project-orphan-*`)
   * or left for the operator — the sweep deliberately does not walk
   * `projects/`, because a rowless directory is inert and deleting it would
   * destroy whatever the operator (or an agent) put there before the row was
   * written.
   *
   * **Non-vacuous exemption:** the sweep refuses to claim success if the
   * `projects/` directory itself is missing. That is the sentinel: a sweep
   * that ran against a data directory where projects/ has vanished would
   * otherwise "pass" while reading nothing. If `projects/` disappears, the
   * sweep **fails** rather than silently passing.
   *
   * A log line (and an audit-worthy fact in the return value) is emitted only
   * when something was actually removed.
   */
  bootSweep(): SweepResult {
    if (!existsSync(this.#projectsDir)) {
      throw new Error(
        'project staging sweep refused: the projects directory is missing (non-vacuous exemption)',
      );
    }

    const removed: string[] = [];
    const now = this.#clock.now();
    let entries: string[];
    try {
      entries = readdirSync(this.#dataDir);
    } catch (err) {
      throw new Error(
        `project staging sweep refused: data directory unreadable: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }

    for (const name of entries) {
      if (!name.startsWith(STAGING_PREFIX)) continue;
      const full = join(this.#dataDir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const age = now - st.mtimeMs;
      if (age < STAGING_MIN_AGE_MS) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(name);
    }

    if (removed.length > 0) {
      this.#log({
        message: 'swept abandoned project staging directories',
        count: removed.length,
        names: removed,
      });
    }

    return { removed };
  }

  /** Force a staging directory's mtime into the past. Test helper, not production. */
  ageStagingForTest(name: string, ageMs: number): void {
    const full = join(this.#dataDir, name);
    const when = (this.#clock.now() - ageMs) / 1000;
    utimesSync(full, when, when);
  }

  /** List current staging directory names. Test helper. */
  listStaging(): string[] {
    return readdirSync(this.#dataDir).filter((n) => n.startsWith(STAGING_PREFIX));
  }

  /** List current orphan quarantine directory names. Test helper. */
  listOrphans(): string[] {
    return readdirSync(this.#dataDir).filter((n) => n.startsWith(ORPHAN_PREFIX));
  }

  #buildTree(root: string, meta: ProjectJson): void {
    mkdirSync(root, { recursive: true, mode: DIR_MODE });
    // claude-home is a SIBLING of workspace, never a descendant: CLAUDE_CONFIG_DIR
    // replaces ~/.claude (lowest precedence), and a .claude/settings.json inside
    // the workspace would override it — and would also be importable content.
    mkdirSync(join(root, 'workspace'), { recursive: true, mode: DIR_MODE });
    mkdirSync(join(root, 'claude-home'), { recursive: true, mode: DIR_MODE });
    writeProjectJsonAtomic(join(root, 'project.json'), meta);
    // Re-assert modes: mkdirSync honours umask, so set them explicitly.
    chmodSafe(join(root, 'workspace'), DIR_MODE);
    chmodSafe(join(root, 'claude-home'), DIR_MODE);
    chmodSafe(root, DIR_MODE);
  }
}

/**
 * Writes `project.json` atomically: a temporary file in the same directory,
 * then `rename(2)`. Same-filesystem rename keeps a reader from seeing a
 * half-written document.
 *
 * The denylist is enforced at write time as well as by the test: a future
 * caller that spreads an object carrying a credential gets a throw here
 * rather than a silent leak onto the volume.
 */
export function writeProjectJsonAtomic(path: string, doc: ProjectJson): void {
  for (const key of Object.keys(doc) as (keyof ProjectJson)[]) {
    if ((PROJECT_JSON_DENYLIST as readonly string[]).includes(key)) {
      throw new Error(`project.json must not contain key: ${key}`);
    }
  }
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: FILE_MODE });
  chmodSafe(temp, FILE_MODE);
  renameSync(temp, path);
  chmodSafe(path, FILE_MODE);
}

function chmodSafe(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // A filesystem that will not chmod still has the mode the create used.
  }
}

/**
 * Builds a test-owned temporary data root. Every filesystem test must use
 * this (or `mkdtemp`) rather than the real `/data`.
 */
export function makeTempDataRoot(prefix = 'panel-project-store-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
