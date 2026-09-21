import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb } from '../../src/server/db.js';
import {
  normalizeSlug,
  SlugError,
  ProjectsRepository,
  ProjectNotFoundError,
} from '../../src/server/services/projects.service.js';

let dataDir: string | null = null;

afterEach(() => {
  closeDb();
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
});

function freshDb(): ProjectsRepository {
  dataDir = mkdtempSync(join(tmpdir(), 'panel-projects-test-'));
  initDb(join(dataDir, 'test.db'));
  return new ProjectsRepository({ db: getDb() });
}

describe('M2.2 — slug normalisation', () => {
  describe('normalizeSlug', () => {
    it('accepts valid slugs at boundary lengths', () => {
      // 2 characters: the minimum
      expect(normalizeSlug('ab')).toBe('ab');
      // 3 characters
      expect(normalizeSlug('abc')).toBe('abc');
      // 39 characters
      expect(normalizeSlug('a'.repeat(37) + 'bc')).toBe('a'.repeat(37) + 'bc');
      // 40 characters: the maximum
      expect(normalizeSlug('a'.repeat(38) + 'bc')).toBe('a'.repeat(38) + 'bc');
    });

    it('rejects leading or trailing hyphen', () => {
      expect(() => normalizeSlug('-abc')).toThrow(SlugError);
      expect(() => normalizeSlug('abc-')).toThrow(SlugError);
    });

    it('rejects uppercase input as-is but normalises it', () => {
      // Uppercase is normalised to lowercase, so "ABC" becomes "abc"
      expect(normalizeSlug('ABC')).toBe('abc');
      // But a slug that is ONLY uppercase letters still passes after normalisation
      expect(normalizeSlug('MyProject')).toBe('myproject');
    });

    it('rejects 41 characters', () => {
      expect(() => normalizeSlug('a'.repeat(39) + 'bc')).toThrow(SlugError);
    });

    it('rejects 1 character', () => {
      expect(() => normalizeSlug('a')).toThrow(SlugError);
    });

    it('rejects empty string', () => {
      expect(() => normalizeSlug('')).toThrow(SlugError);
    });

    it('rejects a single hyphen', () => {
      expect(() => normalizeSlug('-')).toThrow(SlugError);
    });

    it('accepts hyphens in the middle', () => {
      expect(normalizeSlug('my-project')).toBe('my-project');
      expect(normalizeSlug('a-b-c-d')).toBe('a-b-c-d');
    });

    it('normalises NFC: combining sequence vs precomposed form', () => {
      // e + combining acute accent (U+0301) vs precomposed é (U+00E9).
      // Both normalise to the same NFC form (é), which is non-ASCII and
      // rejected by the ASCII-only slug pattern. The important property:
      // two inputs that fold to the same value cannot create two rows,
      // because neither can create one.
      const decomposed = 'e\u0301';
      const precomposed = '\u00E9';
      expect(() => normalizeSlug(decomposed)).toThrow(SlugError);
      expect(() => normalizeSlug(precomposed)).toThrow(SlugError);
    });

    it('normalises case: Turkish dotless i and dotted I are rejected', () => {
      // Turkish dotless I (U+0131) stays as U+0131 after toLowerCase (JS is
      // not locale-aware), which is non-ASCII and rejected. Dotted I (U+0049)
      // becomes 'i', which IS ASCII and accepted when part of a valid slug.
      expect(() => normalizeSlug('x\u0131x')).toThrow(SlugError);
      expect(normalizeSlug('IxI')).toBe('ixi');
    });

    it('normalises the Kelvin sign (U+212A) to k', () => {
      // Kelvin sign (U+212A) lowercases to 'k' in JavaScript, so 'x\u212Ax'
      // becomes 'xkx' — a valid ASCII slug. The two inputs normalise to the
      // same value, so they cannot create two different rows.
      expect(normalizeSlug('x\u212Ax')).toBe('xkx');
      expect(normalizeSlug('xkx')).toBe('xkx');
    });

    it('normalises full-width Latin characters — non-ASCII, rejected', () => {
      // Full-width A (U+FF21) and full-width a (U+FF41) both normalise to
      // non-ASCII values and are rejected. Two inputs that fold identically
      // cannot create two rows because neither can create one.
      expect(() => normalizeSlug('\uFF21')).toThrow(SlugError);
      expect(() => normalizeSlug('\uFF41')).toThrow(SlugError);
    });

    it('Persian and Arabic-Indic digits are rejected', () => {
      // Persian digits: ۰۱۲۳۴۵۶۷۸۹
      expect(() => normalizeSlug('۱۲۳')).toThrow(SlugError);
      // Arabic-Indic digits: ٠١٢٣٤٥٦٧٨٩
      expect(() => normalizeSlug('١٢٣')).toThrow(SlugError);
      // They are not transliterated — the slug pattern only allows ASCII digits
    });
  });

  describe('collision chain', () => {
    it('three creates of the same label produce label, label-2, label-3', () => {
      const repo = freshDb();

      const first = repo.create({ slug: 'my-project' });
      expect(first.project.slug).toBe('my-project');
      expect(first.renamed).toBe(false);

      const second = repo.create({ slug: 'my-project' });
      expect(second.project.slug).toBe('my-project-2');
      expect(second.renamed).toBe(true);

      const third = repo.create({ slug: 'my-project' });
      expect(third.project.slug).toBe('my-project-3');
      expect(third.renamed).toBe(true);

      // All three exist with distinct slugs
      const all = repo.list();
      expect(all).toHaveLength(3);
      expect(all.map((p) => p.slug)).toEqual(['my-project', 'my-project-2', 'my-project-3']);
    });

    it('collision with different casing resolves to the same chain', () => {
      const repo = freshDb();

      const first = repo.create({ slug: 'MyProject' });
      expect(first.project.slug).toBe('myproject');
      expect(first.renamed).toBe(false);

      const second = repo.create({ slug: 'myproject' });
      expect(second.project.slug).toBe('myproject-2');
      expect(second.renamed).toBe(true);
    });

    it('suffix does not push slug past 40 characters', () => {
      const repo = freshDb();

      // 38-char stem: "a".repeat(36) + "bc" = 38 chars
      const stem = 'a'.repeat(36) + 'bc';
      const first = repo.create({ slug: stem });
      expect(first.project.slug).toBe(stem);
      expect(first.project.slug.length).toBe(38);

      // The collision suffix -2 adds 2 chars → 40 total
      const second = repo.create({ slug: stem });
      expect(second.project.slug).toBe(stem + '-2');
      expect(second.project.slug.length).toBe(40);
      expect(second.renamed).toBe(true);

      // A third collision: -3 adds 2 chars → still 40
      const third = repo.create({ slug: stem });
      expect(third.project.slug).toBe(stem + '-3');
      expect(third.project.slug.length).toBe(40);
    });

    it('truncation of long stem on collision preserves validity', () => {
      const repo = freshDb();

      // 39-char stem: 'a'.repeat(37) + 'bc' = 39 chars
      const stem = 'a'.repeat(37) + 'bc';
      const first = repo.create({ slug: stem });
      expect(first.project.slug).toBe(stem);

      // -2 suffix: stem is 39 chars, total would be 41, so truncate stem to
      // 40 - 2 = 38 chars: 'a'.repeat(36) + 'bc'. Wait — truncating 39 to 38
      // removes the last char: 'a'.repeat(37) + 'b'. Then append '-2':
      // 'a'.repeat(37) + 'b-2' = 40 chars, which is valid.
      const second = repo.create({ slug: stem });
      expect(second.project.slug).toBe('a'.repeat(37) + 'b-2');
      expect(second.project.slug.length).toBe(40);
      expect(second.renamed).toBe(true);
    });
  });

  describe('repository operations', () => {
    it('getByUuid returns the project or null', () => {
      const repo = freshDb();
      const { project } = repo.create({ slug: 'test-proj' });

      expect(repo.getByUuid(project.uuid)).not.toBeNull();
      expect(repo.getByUuid(project.uuid)!.slug).toBe('test-proj');
      expect(repo.getByUuid('nonexistent')).toBeNull();
    });

    it('getBySlug returns the project or null', () => {
      const repo = freshDb();
      repo.create({ slug: 'test-proj' });

      expect(repo.getBySlug('test-proj')).not.toBeNull();
      expect(repo.getBySlug('TEST-PROJ')).not.toBeNull(); // normalised
      expect(repo.getBySlug('nonexistent')).toBeNull();
    });

    it('list returns all projects in creation order', () => {
      const repo = freshDb();
      repo.create({ slug: 'alpha' });
      repo.create({ slug: 'beta' });
      repo.create({ slug: 'gamma' });

      const all = repo.list();
      expect(all).toHaveLength(3);
      expect(all.map((p) => p.slug)).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('rename changes the slug and keeps the UUID', () => {
      const repo = freshDb();
      const { project } = repo.create({ slug: 'old-name' });
      const uuid = project.uuid;

      const renamed = repo.rename(uuid, 'new-name');
      expect(renamed.slug).toBe('new-name');
      expect(renamed.uuid).toBe(uuid);
      expect(renamed.renamed).toBe(false); // no collision

      // Old slug no longer finds it
      expect(repo.getBySlug('old-name')).toBeNull();
      expect(repo.getBySlug('new-name')).not.toBeNull();
    });

    it('rename with collision appends suffix', () => {
      const repo = freshDb();
      repo.create({ slug: 'existing' });
      const second = repo.create({ slug: 'other' });

      const renamed = repo.rename(second.project.uuid, 'existing');
      expect(renamed.slug).toBe('existing-2');
      expect(renamed.renamed).toBe(true);
    });

    it('rename throws ProjectNotFoundError for unknown UUID', () => {
      const repo = freshDb();
      expect(() => repo.rename('nonexistent', 'new-slug')).toThrow(ProjectNotFoundError);
    });

    it('delete removes the row and returns true', () => {
      const repo = freshDb();
      const { project } = repo.create({ slug: 'to-delete' });
      expect(repo.delete(project.uuid)).toBe(true);
      expect(repo.getByUuid(project.uuid)).toBeNull();
    });

    it('delete returns false for unknown UUID', () => {
      const repo = freshDb();
      expect(repo.delete('nonexistent')).toBe(false);
    });

    it('isolatedSettings flag is stored and retrieved', () => {
      const repo = freshDb();
      const { project } = repo.create({ slug: 'isolated', isolatedSettings: true });
      expect(project.isolatedSettings).toBe(true);

      const retrieved = repo.getByUuid(project.uuid)!;
      expect(retrieved.isolatedSettings).toBe(true);
    });
  });
});
