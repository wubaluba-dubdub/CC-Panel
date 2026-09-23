import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb, getDb } from '../../src/server/db.js';
import { initCrypto, resetCrypto } from '../../src/server/crypto.js';
import {
  ORPHAN_PREFIX,
  PROJECT_JSON_DENYLIST,
  ProjectStoreService,
  ProjectStoreError,
  DiskGuardRefusedError,
  STAGING_MIN_AGE_MS,
  STAGING_PREFIX,
  projectScope,
  writeProjectJsonAtomic,
  type ProjectJson,
} from '../../src/server/services/project-store.service.js';
import { ProjectsRepository } from '../../src/server/services/projects.service.js';
import { SecretsRepository } from '../../src/server/services/secrets.service.js';
import { AuditService, AuditEvent } from '../../src/server/services/audit.service.js';
import type { DiskReading } from '../../src/server/services/resources.service.js';
import { FakeClock } from '../helpers/fake-clock.js';

const KEY = randomBytes(32).toString('base64');
const GIB = 1024 * 1024 * 1024;

let dataDir: string;
let clock: FakeClock;
let logs: Record<string, unknown>[];

function store(opts: Partial<ConstructorParameters<typeof ProjectStoreService>[0]> = {}): ProjectStoreService {
  logs = [];
  return new ProjectStoreService({
    dataDir,
    clock,
    log: (e) => {
      logs.push(e);
    },
    ...opts,
  });
}

/** A volume at a chosen used-fraction, since statfs cannot be arranged. */
function volumeAt(fraction: number): (path: string) => DiskReading {
  return (path) => ({
    path,
    totalBytes: 100 * GIB,
    usedBytes: Math.round(fraction * 100 * GIB),
    availableBytes: Math.round((1 - fraction) * 100 * GIB),
    databaseBytes: 4096,
  });
}

function walk(root: string): string[] {
  const out: string[] = [];
  const go = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      out.push(rel);
      if (entry.isDirectory()) go(join(dir, entry.name), rel);
    }
  };
  go(root, '');
  return out.sort();
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'panel-project-store-'));
  mkdirSync(join(dataDir, 'projects'), { recursive: true, mode: 0o700 });
  clock = new FakeClock();
  logs = [];
  initDb(join(dataDir, 'panel.db'));
  resetCrypto();
  initCrypto(KEY);
});

afterEach(() => {
  closeDb();
  resetCrypto();
  rmSync(dataDir, { recursive: true, force: true });
});

// ─── 7.1 Layout ─────────────────────────────────────────────────────────────

describe('M2.2 — the per-project layout', () => {
  it('creates workspace beside claude-home, not inside it', () => {
    const s = store();
    const { project } = s.create({ slug: 'layout-proj' });
    const uuid = project.uuid;

    const projectDir = s.projectDir(uuid);
    const workspace = s.workspaceDir(uuid);
    const claudeHome = s.claudeHomeDir(uuid);

    expect(existsSync(workspace)).toBe(true);
    expect(existsSync(claudeHome)).toBe(true);
    expect(existsSync(s.projectJsonPath(uuid))).toBe(true);

    // Sibling rule: claude-home is under projectDir, NOT under workspace.
    expect(claudeHome.startsWith(workspace)).toBe(false);
    expect(claudeHome.startsWith(projectDir + '/')).toBe(true);
    expect(workspace.startsWith(projectDir + '/')).toBe(true);
    // And not a descendant at any depth.
    const walkPaths = walk(projectDir);
    expect(walkPaths).toContain('workspace');
    expect(walkPaths).toContain('claude-home');
    expect(walkPaths.some((p) => p.startsWith('workspace/claude-home'))).toBe(false);
  });

  it('gives directories mode 0700 and files mode 0600 — no execute bit on files', () => {
    const s = store();
    const { project } = s.create({ slug: 'modes' });
    const uuid = project.uuid;

    for (const dir of [s.projectDir(uuid), s.workspaceDir(uuid), s.claudeHomeDir(uuid)]) {
      const mode = statSync(dir).mode & 0o777;
      expect(mode).toBe(0o700);
      // Directories need the execute bit to be traversable; 0700 includes it.
      expect(mode & 0o100).toBe(0o100);
    }

    const jsonMode = statSync(s.projectJsonPath(uuid)).mode & 0o777;
    expect(jsonMode).toBe(0o600);
    expect(jsonMode & 0o111).toBe(0);
  });

  it('project.json carries only the five allowed keys', () => {
    const s = store();
    const { project } = s.create({ slug: 'meta', isolatedSettings: true });
    const doc = JSON.parse(readFileSync(s.projectJsonPath(project.uuid), 'utf-8')) as ProjectJson;
    expect(Object.keys(doc).sort()).toEqual([
      'createdAt',
      'isolatedSettings',
      'schemaVersion',
      'slug',
      'uuid',
    ]);
    expect(doc.uuid).toBe(project.uuid);
    expect(doc.slug).toBe('meta');
    expect(doc.isolatedSettings).toBe(true);
    expect(doc.schemaVersion).toBe(1);
  });
});

// ─── 7.2 Atomic creation — three failure paths ──────────────────────────────

describe('M2.2 — the three creation failure paths', () => {
  it('staging fails → nothing on disk, nothing in the database', () => {
    const s = store({ failStaging: true });
    expect(() => s.create({ slug: 'doomed' })).toThrow(ProjectStoreError);
    try {
      s.create({ slug: 'doomed' });
    } catch (err) {
      expect((err as ProjectStoreError).phase).toBe('staging');
    }
    expect(readdirSync(dataDir).filter((n) => n.startsWith(STAGING_PREFIX))).toEqual([]);
    expect(readdirSync(join(dataDir, 'projects'))).toEqual([]);
    expect(new ProjectsRepository().list()).toEqual([]);
  });

  it('rename fails → staging removed, nothing in the database', () => {
    const s = store({ failRename: true });
    try {
      s.create({ slug: 'doomed' });
      expect.unreachable('rename should have failed');
    } catch (err) {
      expect((err as ProjectStoreError).phase).toBe('rename');
    }
    expect(readdirSync(dataDir).filter((n) => n.startsWith(STAGING_PREFIX))).toEqual([]);
    expect(readdirSync(join(dataDir, 'projects'))).toEqual([]);
    expect(new ProjectsRepository().list()).toEqual([]);
  });

  it('database commit fails → promoted directory is quarantined, not left under projects/', () => {
    const logsSeen: Record<string, unknown>[] = [];
    const s = store({
      failDatabase: true,
      log: (e) => {
        logsSeen.push(e);
      },
    });
    try {
      s.create({ slug: 'quarantine-me' });
      expect.unreachable('database should have failed');
    } catch (err) {
      expect((err as ProjectStoreError).phase).toBe('database');
    }

    // Nothing under projects/, the staging prefix is gone, and an orphan
    // quarantine directory exists beside projects/.
    expect(readdirSync(join(dataDir, 'projects'))).toEqual([]);
    expect(readdirSync(dataDir).filter((n) => n.startsWith(STAGING_PREFIX))).toEqual([]);
    const orphans = readdirSync(dataDir).filter((n) => n.startsWith(ORPHAN_PREFIX));
    expect(orphans).toHaveLength(1);

    // The log line names the quarantine and the uuid, never a base path.
    const line = logsSeen.find((e) => String(e.message).includes('quarantined'));
    expect(line).toBeDefined();
    expect(line!.quarantined).toBe(true);
    expect(typeof line!.uuid).toBe('string');
    expect(JSON.stringify(line)).not.toContain(dataDir);
    expect(new ProjectsRepository().list()).toEqual([]);
  });
});

// ─── 7.3 Boot sweep ─────────────────────────────────────────────────────────

describe('M2.2 — boot sweep for abandoned staging', () => {
  function makeStaging(name: string): void {
    mkdirSync(join(dataDir, name), { recursive: true, mode: 0o700 });
    mkdirSync(join(dataDir, name, 'workspace'), { recursive: true, mode: 0o700 });
  }

  it('removes staging older than the age guard and keeps younger staging', () => {
    const s = store();
    const oldName = `${STAGING_PREFIX}old-one`;
    const youngName = `${STAGING_PREFIX}young-one`;
    makeStaging(oldName);
    makeStaging(youngName);
    s.ageStagingForTest(oldName, STAGING_MIN_AGE_MS + 1000);
    // youngName keeps its fresh mtime.

    const result = s.bootSweep();
    expect(result.removed).toEqual([oldName]);
    expect(existsSync(join(dataDir, oldName))).toBe(false);
    expect(existsSync(join(dataDir, youngName))).toBe(true);
    // Non-vacuous: the kept entry really existed and really survived.
    expect(readdirSync(dataDir)).toContain(youngName);
  });

  it('logs and returns a fact only when it actually removed something', () => {
    const s = store();
    // No staging at all.
    const quiet = s.bootSweep();
    expect(quiet.removed).toEqual([]);
    expect(logs.filter((l) => String(l.message).includes('swept'))).toHaveLength(0);

    const name = `${STAGING_PREFIX}to-sweep`;
    makeStaging(name);
    s.ageStagingForTest(name, STAGING_MIN_AGE_MS + 1000);
    const loud = s.bootSweep();
    expect(loud.removed).toEqual([name]);
    expect(logs.filter((l) => String(l.message).includes('swept'))).toHaveLength(1);
  });

  it('FAILS (does not silently pass) when the projects directory is missing', () => {
    const s = store();
    rmSync(join(dataDir, 'projects'), { recursive: true, force: true });
    expect(() => s.bootSweep()).toThrow(/projects directory is missing/);
  });

  it('does not see a promoted project directory that has no database row', () => {
    // Create for real, then delete only the row — leaving a promoted dir orphan.
    const s = store();
    const { project } = s.create({ slug: 'orphan-row' });
    const uuid = project.uuid;
    // Remove the row directly; directory stays.
    expect(new ProjectsRepository().delete(uuid)).toBe(true);
    expect(existsSync(s.projectDir(uuid))).toBe(true);
    expect(new ProjectsRepository().getByUuid(uuid)).toBeNull();

    // Sweep: the orphan under projects/ is untouched.
    const result = s.bootSweep();
    expect(result.removed).toEqual([]);
    expect(existsSync(s.projectDir(uuid))).toBe(true);
  });
});

// ─── 7.4 Deletion ───────────────────────────────────────────────────────────

describe('M2.2 — deletion order and crash residuals', () => {
  function seed(): { uuid: string; scope: string } {
    const s = store();
    const { project } = s.create({ slug: 'to-delete' });
    const uuid = project.uuid;
    const scope = projectScope(uuid);
    new SecretsRepository().set(scope, 'api_key', 'sk-ant-sentinel-value');
    new SecretsRepository().set(scope, 'hook_token', 'hook-sentinel-value');
    // An audit row that must survive.
    new AuditService().write({
      event: AuditEvent.LoginSuccess,
      outcome: 'success',
      meta: { note: 'must survive project deletion' },
    });
    return { uuid, scope };
  }

  it('removes workspace, claude-home, project.json, the directory, the row, and secrets — and KEEPS audit', () => {
    const s = store();
    const { uuid, scope } = seed();
    const auditBefore = (getDb().prepare('SELECT COUNT(*) AS c FROM audit_log').get() as {
      c: number;
    }).c;
    expect(auditBefore).toBeGreaterThan(0);

    const result = s.delete(uuid);
    expect(result.rowDeleted).toBe(true);
    expect(result.secretsDeleted).toBe(2);
    expect(result.dirRemoved).toBe(true);

    expect(existsSync(s.projectDir(uuid))).toBe(false);
    expect(existsSync(s.workspaceDir(uuid))).toBe(false);
    expect(existsSync(s.claudeHomeDir(uuid))).toBe(false);
    expect(existsSync(s.projectJsonPath(uuid))).toBe(false);
    expect(new ProjectsRepository().getByUuid(uuid)).toBeNull();
    expect(new SecretsRepository().list(scope)).toEqual([]);

    const auditAfter = (getDb().prepare('SELECT COUNT(*) AS c FROM audit_log').get() as {
      c: number;
    }).c;
    expect(auditAfter).toBe(auditBefore);
  });

  it('crash after the database step leaves the directory and nothing in the database', () => {
    const s = store({ crashAfter: 'db' });
    const { uuid, scope } = seed();
    expect(() => s.delete(uuid)).toThrow(/simulated crash after database/);

    // Row and secrets gone; directory still present — inert, invisible in UI.
    expect(new ProjectsRepository().getByUuid(uuid)).toBeNull();
    expect(new SecretsRepository().list(scope)).toEqual([]);
    expect(existsSync(s.projectDir(uuid))).toBe(true);
    expect(existsSync(s.workspaceDir(uuid))).toBe(true);
    expect(existsSync(s.projectJsonPath(uuid))).toBe(true);
  });

  it('crash after the filesystem step leaves everything this prompt deletes gone', () => {
    const s = store({ crashAfter: 'fs' });
    const { uuid, scope } = seed();
    expect(() => s.delete(uuid)).toThrow(/simulated crash after filesystem/);

    expect(new ProjectsRepository().getByUuid(uuid)).toBeNull();
    expect(new SecretsRepository().list(scope)).toEqual([]);
    expect(existsSync(s.projectDir(uuid))).toBe(false);
  });

  it('is non-vacuous: it first creates the entry that must survive and the one that must be removed', () => {
    const s = store();
    const { uuid } = seed();
    // A second project that must survive.
    const survivor = s.create({ slug: 'survivor' }).project;

    s.delete(uuid);

    expect(existsSync(s.projectDir(uuid))).toBe(false);
    expect(existsSync(s.projectDir(survivor.uuid))).toBe(true);
    expect(new ProjectsRepository().getByUuid(survivor.uuid)).not.toBeNull();
  });
});

// ─── 7.5 Secret scope and AAD ───────────────────────────────────────────────

describe('M2.2 — secret scope helper', () => {
  it('builds project:<uuid> and rejects a colon in the component', () => {
    const uuid = '9f8e2c1a-0000-4000-8000-123456789abc';
    expect(projectScope(uuid)).toBe(`project:${uuid}`);
    expect(() => projectScope('has:colon')).toThrow(/must not contain/);
    expect(() => projectScope('')).toThrow(/must not be empty/);
  });

  it('rejects a colon the same way columnAad rejects one in a component', async () => {
    const { columnAad } = await import('../../src/server/crypto.js');
    expect(() => columnAad('secrets', 'project:7', 'x')).not.toThrow();
    expect(() => columnAad('secrets', 'project', '7:x')).toThrow(/must not contain/);
    expect(() => projectScope('7:x')).toThrow(/must not contain/);
  });

  it('proves the secrets table has no secrets:project:<integer-id> rows to migrate', () => {
    const repo = new SecretsRepository();
    // Fresh database through migration 012: the table starts empty of project scopes.
    const projectScoped = repo.list().filter((m) => m.scope.startsWith('project:'));
    expect(projectScoped).toEqual([]);

    // And no row anywhere uses the integer-id hook_token form.
    const all = repo.list();
    const integerHook = all.filter(
      (m) => m.scope.startsWith('project:') && !m.scope.slice('project:'.length).includes('-'),
    );
    expect(integerHook).toEqual([]);
  });

  it('deleteScope removes every secret under one project scope and leaves others', () => {
    const repo = new SecretsRepository();
    const scopeA = projectScope('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const scopeB = projectScope('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    repo.set(scopeA, 'api_key', 'value-a');
    repo.set(scopeA, 'hook_token', 'value-b');
    repo.set(scopeB, 'api_key', 'value-c');
    repo.set('global', 'api_key', 'value-g');

    expect(repo.deleteScope(scopeA)).toBe(2);
    expect(repo.list(scopeA)).toEqual([]);
    expect(repo.list(scopeB)).toHaveLength(1);
    expect(repo.list('global')).toHaveLength(1);
  });

  it('AAD form for a project secret is secrets:project:<uuid>:<name>', async () => {
    const { columnAad } = await import('../../src/server/crypto.js');
    const uuid = '9f8e2c1a-0000-4000-8000-123456789abc';
    expect(columnAad('secrets', projectScope(uuid), 'api_key')).toBe(
      `secrets:project:${uuid}:api_key`,
    );
    expect(columnAad('secrets', projectScope(uuid), 'hook_token')).toBe(
      `secrets:project:${uuid}:hook_token`,
    );
  });
});

// ─── 7.6 Disk guard ─────────────────────────────────────────────────────────

describe('M2.2 — disk guard', () => {
  it('allows creation below the threshold', () => {
    const s = store({
      disk: { thresholdPercent: () => 80, readDisk: volumeAt(0.5) },
    });
    expect(s.checkDisk()).toEqual({ allowed: true, reason: 'below_threshold' });
    expect(() => s.create({ slug: 'below' })).not.toThrow();
  });

  it('refuses creation at or above the threshold with a generic message', () => {
    const s = store({
      disk: { thresholdPercent: () => 80, readDisk: volumeAt(0.9) },
    });
    expect(s.checkDisk()).toEqual({ allowed: false, reason: 'above_threshold' });
    let message = '';
    try {
      s.create({ slug: 'above' });
    } catch (err) {
      expect(err).toBeInstanceOf(DiskGuardRefusedError);
      message = (err as Error).message;
    }
    expect(message).toBe('insufficient disk space to create a project');
    // No path from /data, no byte count, no base path.
    expect(message).not.toContain('/data');
    expect(message).not.toContain(dataDir);
    expect(message).not.toMatch(/\d{6,}/);
    expect(readdirSync(join(dataDir, 'projects'))).toEqual([]);
    expect(new ProjectsRepository().list()).toEqual([]);
  });

  it('treats a disabled threshold as allowed — never defaulted to refusing', () => {
    const s = store({
      disk: { thresholdPercent: () => null, readDisk: volumeAt(0.99) },
    });
    expect(s.checkDisk()).toEqual({ allowed: true, reason: 'disabled' });
    expect(() => s.create({ slug: 'disabled' })).not.toThrow();
  });

  it('treats an unreadable volume (totalBytes 0) as disabled, not as 100%', () => {
    const s = store({
      disk: {
        thresholdPercent: () => 80,
        readDisk: (path) => ({
          path,
          totalBytes: 0,
          usedBytes: 0,
          availableBytes: 0,
          databaseBytes: 0,
        }),
      },
    });
    expect(s.checkDisk()).toEqual({ allowed: true, reason: 'disabled' });
  });

  it('reads its threshold from the injected provider (the watchdog), not a parallel constant', () => {
    // The threshold is whatever the provider returns — here 70 rather than the
    // default 80 — so a second hard-coded number would fail this test.
    const s = store({
      disk: { thresholdPercent: () => 70, readDisk: volumeAt(0.75) },
    });
    expect(s.checkDisk().allowed).toBe(false);
    const s2 = store({
      disk: { thresholdPercent: () => 70, readDisk: volumeAt(0.69) },
    });
    expect(s2.checkDisk().allowed).toBe(true);
  });
});

// ─── project.json denylist ──────────────────────────────────────────────────

describe('M2.2 — project.json denylist', () => {
  it('the written file contains none of the denylisted key names', () => {
    const s = store();
    const { project } = s.create({ slug: 'denylist' });
    const raw = readFileSync(s.projectJsonPath(project.uuid), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    for (const denied of PROJECT_JSON_DENYLIST) {
      expect(keys).not.toContain(denied);
      expect(raw.toLowerCase()).not.toContain(`"${denied.toLowerCase()}"`);
    }
    // And the denylist itself is non-empty (non-vacuous).
    expect(PROJECT_JSON_DENYLIST.length).toBeGreaterThan(5);
  });

  it('writeProjectJsonAtomic refuses a document carrying a denylisted key', () => {
    const path = join(dataDir, 'projects', 'project.json');
    const bad = {
      uuid: 'x',
      slug: 'x',
      createdAt: '2026-01-01T00:00:00.000Z',
      schemaVersion: 1,
      isolatedSettings: false,
      api_key: 'sk-ant-should-not-be-here',
    } as unknown as ProjectJson;
    expect(() => writeProjectJsonAtomic(path, bad)).toThrow(/must not contain key/);
    expect(existsSync(path)).toBe(false);
  });
});

// ─── Writes nothing outside the project dir and staging sibling ─────────────

describe('M2.2 — creation writes nothing outside the project directory and staging sibling', () => {
  it('the only new paths under the data root are projects/<uuid>/ (staging is renamed away)', () => {
    const s = store();
    const before = walk(dataDir);
    const { project } = s.create({ slug: 'contained' });
    const after = walk(dataDir);

    const added = after.filter((p) => !before.includes(p));
    const expectedPrefix = `projects/${project.uuid}`;
    for (const path of added) {
      expect(
        path === expectedPrefix || path.startsWith(`${expectedPrefix}/`),
        `unexpected new path: ${path}`,
      ).toBe(true);
    }
    // Staging sibling is gone after a successful create.
    expect(after.filter((p) => p.startsWith(STAGING_PREFIX))).toEqual([]);
    // And the project tree is exactly the three required entries at the top.
    const top = readdirSync(join(dataDir, 'projects', project.uuid)).sort();
    expect(top).toEqual(['claude-home', 'project.json', 'workspace']);
  });
});

// ─── Repository integration: optional uuid ──────────────────────────────────

describe('M2.2 — ProjectsRepository accepts a pre-generated uuid', () => {
  it('uses the supplied uuid so the directory name and the row agree', () => {
    const uuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const repo = new ProjectsRepository();
    const { project } = repo.create({ slug: 'with-uuid', uuid });
    expect(project.uuid).toBe(uuid);
    expect(repo.getByUuid(uuid)!.slug).toBe('with-uuid');
  });
});

// ─── Age guard constant is the one the prompt requires us to state ──────────

describe('M2.2 — staging age guard', () => {
  it('is one minute, and the sweep respects it exactly at the boundary', () => {
    expect(STAGING_MIN_AGE_MS).toBe(60_000);
    const s = store();
    const name = `${STAGING_PREFIX}boundary`;
    mkdirSync(join(dataDir, name), { recursive: true });
    // Exactly at the boundary: age < MIN is kept, age >= MIN is swept.
    s.ageStagingForTest(name, STAGING_MIN_AGE_MS - 1);
    expect(s.bootSweep().removed).toEqual([]);
    expect(existsSync(join(dataDir, name))).toBe(true);
    s.ageStagingForTest(name, STAGING_MIN_AGE_MS);
    expect(s.bootSweep().removed).toEqual([name]);
    expect(existsSync(join(dataDir, name))).toBe(false);
  });
});

// ─── Import columns still unused after this prompt ──────────────────────────

describe('M2.2 — this prompt does not touch the seven import columns', () => {
  it('create/delete projections never name them', () => {
    const s = store();
    const { project } = s.create({ slug: 'import-cols' });
    const record = new ProjectsRepository().getByUuid(project.uuid)!;
    for (const col of [
      'origin',
      'origin_ref',
      'origin_at',
      'source_install_id',
      'review_state',
      'reviewed_at',
      'artefacts_json',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(record, col)).toBe(false);
    }
    s.delete(project.uuid);
  });
});

// ─── lstat: no symlinks ─────────────────────────────────────────────────────

describe('M2.2 — no symlinks in the layout', () => {
  it('workspace and claude-home are real directories, not symlinks', () => {
    const s = store();
    const { project } = s.create({ slug: 'nosym' });
    expect(lstatSync(s.workspaceDir(project.uuid)).isSymbolicLink()).toBe(false);
    expect(lstatSync(s.claudeHomeDir(project.uuid)).isSymbolicLink()).toBe(false);
    expect(lstatSync(s.projectDir(project.uuid)).isSymbolicLink()).toBe(false);
  });
});
