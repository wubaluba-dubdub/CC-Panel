import Database from 'better-sqlite3';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../env.js';
import { CANONICAL_UUID } from '../../shared/project-identity.js';
import { normalizeSlug, ProjectsRepository } from '../services/projects.service.js';

/**
 * `npm run project:path -- <slug>` — print the workspace directory of one project.
 *
 * The operator command the locked M2.2 design promised: a script has to know where a
 * project lives without opening the panel, and `cd projects/<slug>` is not an answer,
 * because directories are named by **uuid** (see `docs/PROJECTS.md` — the slug is a
 * mutable label and the workspace, `claude-home` and every credential AAD are keyed on
 * uuid, so a rename must never move the directory).
 *
 * Three properties this file exists to keep, each of which a simpler implementation
 * would lose:
 *
 * - **It resolves through the repository, never by scanning folders.** The row is the
 *   authority for slug → uuid; a `readdir` over `projects/` would answer from a
 *   stale directory after a failed delete, and would have to guess at normalisation.
 * - **It prints one bare line so shell substitution works.** `ws=$(npm run project:path
 *   -- my-proj)` needs a path and nothing else on stdout — no label, no progress text,
 *   no trailing prose. Everything that is not the path goes to stderr, and there is
 *   exactly one message there.
 * - **Every failure is one generic line.** A missing slug, a malformed slug, an unknown
 *   slug, an unreadable database and a broken environment are indistinguishable to the
 *   caller, because "which of those happened" is the answer a guesser is trying to
 *   collect and the command runs where the panel's own generic error rule applies. It
 *   never lists candidate slugs — that would be a project-name oracle from the shell.
 */

/** The one line every failure produces. Fixed, so nothing about the cause leaks. */
export const PROJECT_PATH_FAILURE = 'project:path: could not resolve that project';

export interface ProjectPathIo {
  out(text: string): void;
  err(text: string): void;
}

/**
 * Injected environment and database access.
 *
 * Injection is what lets the tests prove the contract without touching the real host
 * database: `defaultDeps()` reads the configured data directory and opens the panel's
 * database, while a test supplies a temporary one. Both implementations are used by the
 * suite, so neither the configuration path nor the lookup logic is asserted only through
 * a stub.
 */
export interface ProjectPathDeps {
  /** The configured data directory. Throws when the environment is unusable. */
  dataDir(): string;
  /** Opens the panel database **read-only**. Throws when it cannot be opened. */
  open(dbPath: string): Database.Database;
}

/** Resolves a slug to the absolute `workspace` path of its project. */
export function resolveProjectWorkspace(
  slug: string,
  dataDir: string,
  db: Database.Database,
): string {
  // Canonical slug validation, exactly as the API does it: NFC, lowercase, then the
  // anchored pattern. A `SlugError` message names the pattern and must never reach
  // stderr, so it is caught by the caller along with everything else.
  const normalised = normalizeSlug(slug);

  const project = new ProjectsRepository({ db }).getBySlug(normalised);
  if (project === null) throw new Error('unknown slug');

  // Validate **before** joining: the uuid came out of a database row, and a row that
  // is not a canonical lowercase uuid would otherwise be joined straight into a path.
  // `normalizeSlug` and this check are why the command can be handed arbitrary argv.
  if (!CANONICAL_UUID.test(project.uuid)) throw new Error('non-canonical uuid');

  // Derived from identity, not from the filesystem: no `stat`, no `readdir`, no symlink
  // resolution. The path is correct for a workspace that has not been created yet, and
  // nothing here can be lured through a link into a directory the operator never asked
  // about. `resolve` makes an absolute path even when `PANEL_DATA_DIR` is relative.
  return join(resolve(dataDir), 'projects', project.uuid, 'workspace');
}

/** The real data directory and the real database, per the same rules the server uses. */
function defaultDeps(): ProjectPathDeps {
  return {
    // `loadEnv()` rather than a bare `process.env` read: the data directory is the one
    // value this command needs, and reading it anywhere but through the single resolver
    // would put a second copy of its default in the tree.
    dataDir: () => loadEnv().PANEL_DATA_DIR,
    open: (dbPath) => new Database(dbPath, { readonly: true, fileMustExist: true }),
  };
}

/**
 * Runs the command. Returns the process exit code.
 *
 * Kept separate from `process` so the suite can assert the stdout/stderr contract, the
 * exit codes and the no-mutation property on the same code path the script runs.
 */
export function runProjectPath(
  argv: readonly string[],
  io: ProjectPathIo,
  deps: ProjectPathDeps = defaultDeps(),
): number {
  let db: Database.Database | null = null;
  try {
    if (argv.length !== 1) throw new Error('expected exactly one slug');
    const dataDir = deps.dataDir();
    db = deps.open(join(resolve(dataDir), 'panel.db'));
    const path = resolveProjectWorkspace(argv[0] as string, dataDir, db);
    io.out(`${path}\n`);
    return 0;
  } catch {
    io.err(`${PROJECT_PATH_FAILURE}\n`);
    return 1;
  } finally {
    // A read-only handle still holds the file; the command is one shot, so it is
    // released before the next line of shell runs.
    try {
      db?.close();
    } catch {
      // Nothing to do: the answer (or the failure) has already been produced.
    }
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  process.exit(
    runProjectPath(process.argv.slice(2), {
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    }),
  );
}
