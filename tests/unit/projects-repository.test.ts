import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, initDb } from '../../src/server/db.js';
import { FakeClock } from '../helpers/fake-clock.js';
import { isoFrom } from '../../src/server/utils/clock.js';
import { ProjectNotFoundError, ProjectsRepository } from '../../src/server/services/project.service.js';
import { InvalidSlugError } from '../../src/server/utils/project-slug.js';

let dataDir: string;
let clock: FakeClock;
let repo: ProjectsRepository;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'panel-projects-'));
  initDb(join(dataDir, 'panel.db'));
  clock = new FakeClock();
  repo = new ProjectsRepository({ clock });
});

afterEach(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function rawRow(uuid: string): Record<string, unknown> {
  return getDb().prepare('SELECT * FROM projects WHERE uuid = ?').get(uuid) as Record<string, unknown>;
}

describe('ProjectsRepository', () => {
  it('creates with a canonical slug, a server uuid, and the injected clock', () => {
    const { project, requestedSlug, finalSlug, slugChanged } = repo.create({ slug: 'Alpha-9' });
    expect(project.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.slug).toBe('alpha-9');
    expect(project.isolatedSettings).toBe(false);
    expect(project.createdAt).toBe(isoFrom(clock.now()));
    expect({ requestedSlug, finalSlug, slugChanged }).toEqual({
      requestedSlug: 'alpha-9',
      finalSlug: 'alpha-9',
      slugChanged: false,
    });
    // The seven import columns are never written: NULL means "not imported".
    expect(rawRow(project.uuid)).toMatchObject({
      isolated_settings: 0,
      origin: null,
      origin_ref: null,
      origin_at: null,
      source_install_id: null,
      review_state: null,
      reviewed_at: null,
      artefacts_json: null,
    });
  });

  it('suffixes -2, -3, … on collision and reports the change', () => {
    expect(repo.create({ slug: 'alpha' }).slugChanged).toBe(false);
    const second = repo.create({ slug: 'alpha' });
    expect(second.finalSlug).toBe('alpha-2');
    expect(second.slugChanged).toBe(true);
    expect(repo.create({ slug: 'alpha' }).finalSlug).toBe('alpha-3');
  });

  it('shortens the base at the 40-character limit, deterministically', () => {
    const forty = 'a'.repeat(40);
    repo.create({ slug: forty });
    const second = repo.create({ slug: forty });
    expect(second.finalSlug).toBe('a'.repeat(38) + '-2');
    expect(second.finalSlug).toHaveLength(40);
    // A base whose 38-char prefix ends in '-' is trimmed, not left as `--2`.
    const hyphened = 'a'.repeat(37) + '-zz';
    repo.create({ slug: hyphened });
    expect(repo.create({ slug: hyphened }).finalSlug).toBe('a'.repeat(37) + '-2');
  });

  it('reads by uuid; a slug is not an identity', () => {
    const { project } = repo.create({ slug: 'alpha' });
    expect(repo.get(project.uuid)).toEqual(project);
    expect(repo.get('alpha')).toBeNull();
    expect(() => repo.rename('no-such-uuid', 'beta')).toThrow(ProjectNotFoundError);
  });

  it('lists deterministically by created_at, then id', () => {
    const a = repo.create({ slug: 'aa' }).project;
    const b = repo.create({ slug: 'bb' }).project; // same instant: id breaks the tie
    clock.advance(5_000);
    const c = repo.create({ slug: 'cc' }).project;
    clock.advance(-5_000);
    const d = repo.create({ slug: 'dd' }).project; // earlier clock, higher id
    expect(repo.list().map((p) => p.uuid)).toEqual([a.uuid, b.uuid, d.uuid, c.uuid]);
  });

  it('rename collides by the same suffix rule and reports the change', () => {
    repo.create({ slug: 'alpha' });
    const beta = repo.create({ slug: 'beta' }).project;
    const renamed = repo.rename(beta.uuid, 'alpha');
    expect(renamed.finalSlug).toBe('alpha-2');
    expect(renamed.slugChanged).toBe(true);
    // Renaming to its own canonical slug is a no-op, not a suffix.
    const self = repo.rename(beta.uuid, 'ALPHA-2');
    expect(self.finalSlug).toBe('alpha-2');
    expect(self.slugChanged).toBe(false);
  });

  it('rename changes only the slug — every other column is byte-identical', () => {
    const { project } = repo.create({ slug: 'alpha', isolatedSettings: true });
    const before = rawRow(project.uuid);
    expect(before).toMatchObject({ isolated_settings: 1 }); // schema boolean on the way in
    clock.advance(60_000); // a rename must not touch created_at
    repo.rename(project.uuid, 'beta');
    expect(rawRow(project.uuid)).toEqual({ ...before, slug: 'beta' });
  });

  it('validates before SQL: an invalid slug writes nothing', () => {
    expect(() => repo.create({ slug: 'Bad Slug!' })).toThrow(InvalidSlugError);
    const { project } = repo.create({ slug: 'alpha' });
    expect(() => repo.rename(project.uuid, '-nope')).toThrow(InvalidSlugError);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
  });

  it('exposes exactly create/get/list/rename — no delete, no caller-supplied uuid', () => {
    // Deletion (with its files and scoped secrets) is chunk 4; uuids are generated
    // server-side, so no caller can create a duplicate-uuid row through the API.
    expect(Object.getOwnPropertyNames(ProjectsRepository.prototype).sort()).toEqual([
      'constructor',
      'create',
      'get',
      'list',
      'rename',
    ]);
  });
});
