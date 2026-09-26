import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, initDb } from '../../src/server/db.js';
import { ProjectsRepository } from '../../src/server/services/projects.service.js';
import {
  PROJECT_PATH_FAILURE,
  runProjectPath,
  type ProjectPathDeps,
} from '../../src/server/cli/project-path.js';

/**
 * M2.2 prompt 5 — `npm run project:path -- <slug>`.
 *
 * The command exists so a script can find a project's workspace without opening the
 * panel, which is why every assertion below is about the **contract at the two streams**
 * rather than about the lookup: a path on stdout that shell substitution can use, one
 * fixed line on stderr for every failure, and a database file that is byte-identical
 * afterwards.
 *
 * The two properties with the longest half-life are asserted hardest:
 *
 * - **It cannot mutate anything.** The connection is read-only *and* the proof is the
 *   bytes: `panel.db` is digested before and after and compared, so a future change that
 *   starts writing through a second handle fails here rather than on the operator's
 *   volume. The only entries a run may add are SQLite's own WAL sidecars, which are how
 *   a read-only handle reads a database another process has live.
 * - **It never walks the filesystem.** The workspace directory is deliberately *not*
 *   created by the run — the path comes from the row's uuid — so the successful case
 *   doubles as proof that no directory listing, no `stat` and no symlink resolution is
 *   involved in answering.
 */

/** A representative canonical uuid, so the expected path is exact rather than derived. */
const UUID = '3f6a1d20-9b41-4c7e-8d2a-5e1f0b7c9a44';
const KEY = Buffer.from('a'.repeat(32)).toString('base64');

let dataDir: string | null = null;

afterEach(() => {
  closeDb();
  delete process.env.PANEL_DATA_DIR;
  delete process.env.PANEL_MASTER_KEY;
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
});

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(argv: readonly string[], deps: ProjectPathDeps): Run {
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = runProjectPath(argv, { out: (t) => out.push(t), err: (t) => err.push(t) }, deps);
  return { exitCode, stdout: out.join(''), stderr: err.join('') };
}

/** A temporary data directory holding a real, migrated `panel.db` with one project. */
function fixture(slug = 'alpha-project'): { dir: string; deps: ProjectPathDeps } {
  dataDir = mkdtempSync(join(tmpdir(), 'panel-project-path-'));
  initDb(join(dataDir, 'panel.db'));
  new ProjectsRepository({ db: getDb() }).create({ slug, uuid: UUID });
  closeDb();
  const dir = dataDir;
  return {
    dir,
    deps: {
      dataDir: () => dir,
      open: (dbPath) => new Database(dbPath, { readonly: true, fileMustExist: true }),
    },
  };
}

/** Code only: comments are where an implementation is allowed to *mention* a scan. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('M2.2 — project:path', () => {
  it('prints the workspace absolute path and nothing else', () => {
    const { dir, deps } = fixture();
    const res = run(['alpha-project'], deps);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe('');
    // Exactly one line ending in `\n`, so `ws=$(…)` strips nothing it should keep.
    expect(res.stdout).toBe(`${join(dir, 'projects', UUID, 'workspace')}\n`);
    expect(res.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('normalises the argument exactly as the project domain does', () => {
    const { dir, deps } = fixture('alpha-project');

    for (const argv of [['ALPHA-PROJECT'], ['Alpha-Project']]) {
      const res = run(argv, deps);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe(`${join(dir, 'projects', UUID, 'workspace')}\n`);
    }
  });

  it('fails generically for an unknown slug', () => {
    const { deps } = fixture();
    const res = run(['does-not-exist'], deps);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe(`${PROJECT_PATH_FAILURE}\n`);
    expect(res.stdout).toBe('');
    // No candidate list, no database content, no path.
    expect(res.stderr).not.toContain('alpha-project');
    expect(res.stderr).not.toContain('projects');
    expect(res.stderr).not.toContain('panel.db');
  });

  it('fails identically for every malformed slug', () => {
    const { deps } = fixture();
    const malformed = ['', 'a', '-abc', 'abc-', 'a/b', '..', 'a'.repeat(41), 'x:y', 'x.y'];

    for (const slug of malformed) {
      const res = run([slug], deps);
      expect(res.exitCode, `slug ${JSON.stringify(slug)}`).toBe(1);
      expect(res.stderr).toBe(`${PROJECT_PATH_FAILURE}\n`);
      expect(res.stdout).toBe('');
      // The SlugError message names the pattern; it must never reach the caller.
      expect(res.stderr).not.toContain('slug');
    }
  });

  it('fails generically when the argument count is not exactly one', () => {
    const { deps } = fixture();

    for (const argv of [[], ['a', 'b']]) {
      const res = run(argv, deps);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toBe(`${PROJECT_PATH_FAILURE}\n`);
      expect(res.stdout).toBe('');
    }
  });

  it('refuses a stored uuid that is not canonical, without printing it', () => {
    const { dir, deps } = fixture();
    const hostile = '../../etc/passwd';
    initDb(join(dir, 'panel.db'));
    getDb()
      .prepare('INSERT INTO projects (uuid, slug, isolated_settings, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(hostile, 'hostile', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    closeDb();

    const res = run(['hostile'], deps);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe(`${PROJECT_PATH_FAILURE}\n`);
    expect(res.stdout).toBe('');
    expect(res.stderr + res.stdout).not.toContain('etc/passwd');
  });

  it('changes nothing: the database bytes are identical and no directory is created', () => {
    const { dir, deps } = fixture();
    const digest = (): string => createHash('sha256').update(readFileSync(join(dir, 'panel.db'))).digest('hex');
    const before = digest();
    const beforeNames = readdirSync(dir);

    expect(run(['alpha-project'], deps).exitCode).toBe(0);
    expect(run(['nope'], deps).exitCode).toBe(1);
    expect(run([], deps).exitCode).toBe(1);

    // The database file itself is byte-identical: no row was written, and a read-only
    // handle could not have written one.
    expect(digest()).toBe(before);
    // SQLite may create its own WAL sidecars (`-wal`, `-shm`) beside the file it is
    // reading — they are how a read-only handle reads a database that another process
    // has live — and they are not a write: the WAL is empty afterwards, so nothing was
    // ever written through them. No other entry may appear.
    const added = readdirSync(dir).filter((name) => !beforeNames.includes(name)).sort();
    expect(added.every((name) => name === 'panel.db-wal' || name === 'panel.db-shm')).toBe(true);
    expect(statSync(join(dir, 'panel.db-wal')).size).toBe(0);
    // The workspace is derived, never created — and nothing walked the tree to find it.
    expect(existsSync(join(dir, 'projects'))).toBe(false);
  });

  it('uses the configured data directory through the default dependencies', () => {
    const { dir } = fixture();
    process.env.PANEL_MASTER_KEY = KEY;
    process.env.PANEL_DATA_DIR = dir;

    const out: string[] = [];
    const err: string[] = [];
    const exitCode = runProjectPath(['alpha-project'], {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
    });

    expect(exitCode).toBe(0);
    expect(out.join('')).toBe(`${join(dir, 'projects', UUID, 'workspace')}\n`);
    expect(err.join('')).toBe('');
    expect(existsSync(join(dir, 'projects'))).toBe(false);
  });

  it('reports an unusable environment through the same single line', () => {
    const { dir } = fixture();
    process.env.PANEL_MASTER_KEY = 'too-short';
    process.env.PANEL_DATA_DIR = dir;

    const out: string[] = [];
    const err: string[] = [];
    const exitCode = runProjectPath(['alpha-project'], {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
    });

    expect(exitCode).toBe(1);
    expect(out.join('')).toBe('');
    expect(err.join('')).toBe(`${PROJECT_PATH_FAILURE}\n`);
    expect(err.join('')).not.toContain('MASTER_KEY');
  });

  it('keeps the failure line, the data directory and the database path out of the source', () => {
    const source = code(
      readFileSync(join(import.meta.dirname, '../../src/server/cli/project-path.ts'), 'utf8'),
    );
    // One failure message, defined once and used nowhere else.
    expect(source.split(PROJECT_PATH_FAILURE)).toHaveLength(2);
    // No hard-coded production data directory, and no folder scanning.
    expect(source).not.toMatch(/['"`]\/data['"`]/);
    expect(source).not.toMatch(/readdir|opendir|glob\(/);
    // The database is opened read-only or not at all.
    expect(source).toMatch(/readonly:\s*true/);
    expect(source).not.toMatch(/readonly:\s*false/);
    // The path is built from the validated uuid, after the lookup, never before.
    expect(source).toMatch(/CANONICAL_UUID\.test\(project\.uuid\)/);
  });
});
