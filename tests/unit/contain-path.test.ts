import { afterAll, describe, expect, it } from 'vitest';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  PATH_LIMITS,
  PathEscape,
  resolveInProject,
  validateRelativePath,
  type PathEscapeCode,
  type PathIntent,
} from '../../src/server/utils/contain-path.js';

/**
 * M2.3 prompt 1 — `resolveInProject`, exercised against a real fixture and the
 * adversarial table in docs/FILES.md §2, row by row.
 *
 * Three properties are asserted on *every* case rather than once at the end,
 * because a narrower assertion has been mistaken for them before:
 *
 * - **The exact code.** Each rejection names its `PathEscapeCode`; "it threw"
 *   is not an assertion, and neither is `toThrow(PathEscape)` alone.
 * - **Message hygiene.** Every rejection in this file goes through
 *   `expectEscape` or `expectSyntactic`, which assert the message contains
 *   neither the tmp root nor the input nor `ENOENT`. A future
 *   `new PathEscape(\`…${userPath}\`)` fails here, not in review.
 * - **Containment of every success.** Every acceptance goes through
 *   `expectResolve`, which asserts the absolute path is the root or starts
 *   with `realRoot + sep`. That is also the claude-home sweep: the settings
 *   file with the plaintext API key sits one directory up from the workspace,
 *   and no accepted path may reach it.
 */

/** A representative canonical uuid, so the fixture paths are exact. */
const UUID = '3f6a1d20-9b41-4c7e-8d2a-5e1f0b7c9a44';
/** Stands in for the API key in claude-home/settings.json. */
const SENTINEL = '{"apiKey":"SENTINEL-DO-NOT-REACH"}';
const PANEL_DB_BYTES = 'PANEL-DB-BYTES';
const INTENTS: PathIntent[] = ['list', 'read', 'write', 'create'];

let tmp = '';
let root = '';
let realRoot = '';
let hardlink: string | null = null;

/**
 * Every rejection in the suite passes through here, so hygiene is not a
 * property of one test that the other forty forget.
 */
function assertHygiene(err: PathEscape, code: PathEscapeCode, input: string): void {
  expect(err.name).toBe('PathEscape');
  expect(err.code, `exact code for ${label(input)}`).toBe(code);
  expect(err.message).not.toContain(tmp);
  expect(err.message).not.toContain(realRoot);
  expect(err.message).not.toContain('ENOENT');
  // "" is a substring of every string, so it cannot be checked this way.
  if (input !== '') expect(err.message).not.toContain(input);
}

/** `atRoot` lets the same assertions cover a root that is not the fixture's. */
async function escapeAt(
  atRoot: string,
  input: string,
  code: PathEscapeCode,
  intent: PathIntent,
): Promise<void> {
  const caught: unknown = await resolveInProject(atRoot, input, intent).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(caught, `expected PathEscape(${code}) for ${label(input)}`).toBeInstanceOf(PathEscape);
  assertHygiene(caught as PathEscape, code, input);
}

async function expectEscape(
  input: string,
  code: PathEscapeCode,
  intent: PathIntent = 'read',
): Promise<void> {
  await escapeAt(root, input, code, intent);
}

/**
 * A purely syntactic rejection: the pure validator and the resolver must
 * report the same code, which is what proves the rules are the same rules.
 */
async function expectSyntactic(input: string, code: PathEscapeCode): Promise<void> {
  let caught: unknown;
  try {
    validateRelativePath(input);
  } catch (e) {
    caught = e;
  }
  expect(caught, `validateRelativePath(${label(input)}) must throw ${code}`).toBeInstanceOf(
    PathEscape,
  );
  assertHygiene(caught as PathEscape, code, input);
  await expectEscape(input, code, 'read');
}

/** Acceptance: contained in the resolved root, and `relative` is the input back. */
async function expectResolve(input: string, intent: PathIntent) {
  const resolved = await resolveInProject(root, input, intent);
  expect(
    resolved.absolute === realRoot || resolved.absolute.startsWith(realRoot + sep),
    `escaped the root: ${resolved.absolute}`,
  ).toBe(true);
  expect(resolved.relative, 'relative is the components re-joined').toBe(input);
  return resolved;
}

/** A readable name for inputs that are kilobytes long. */
function label(input: string): string {
  if (input.length <= 40) return JSON.stringify(input);
  return `${JSON.stringify(input.slice(0, 24))}… (${input.length} chars)`;
}

// ---------------------------------------------------------------------------
// The fixture: one real tree per test run, removed afterwards.
// ---------------------------------------------------------------------------

tmp = await mkdtemp(join(tmpdir(), 'panel-contain-'));
const project = join(tmp, 'data', 'projects', UUID);
root = join(project, 'workspace');

await mkdir(join(tmp, 'data'), { recursive: true });
await writeFile(join(tmp, 'data', 'panel.db'), PANEL_DB_BYTES);
await mkdir(root, { recursive: true });
await mkdir(join(project, 'claude-home'), { recursive: true });
await writeFile(join(project, 'claude-home', 'settings.json'), SENTINEL);
await mkdir(join(tmp, 'outside'), { recursive: true });
await writeFile(join(tmp, 'outside', 'secret.txt'), 'OUTSIDE-SECRET');

await writeFile(join(root, 'file.txt'), 'IN-ROOT');
await mkdir(join(root, 'nested'), { recursive: true });
await writeFile(join(root, 'nested', 'inner.txt'), 'INNER');
await writeFile(join(root, '.gitignore'), 'node_modules/\n');
await mkdir(join(root, '.claude'), { recursive: true });
await writeFile(join(root, '.claude', 'settings.json'), '{}');
await mkdir(join(root, 'sub'), { recursive: true });

// Five escape routes, plus one symlink that points back inside the root.
await symlink(join(tmp, 'data', 'panel.db'), join(root, 'db-link'));
await symlink('/etc/passwd', join(root, 'passwd-link'));
await symlink('../claude-home/settings.json', join(root, 'up-link'));
await symlink(join(tmp, 'outside'), join(root, 'outlink'));
await symlink('../..', join(root, 'sub', 'link'));
await symlink('file.txt', join(root, 'inside-link'));

hardlink = 'panel-hardlink';
try {
  await link(join(tmp, 'data', 'panel.db'), join(root, hardlink));
} catch (err) {
  const errno = (err as { code?: string }).code ?? 'unknown';
  hardlink = null;
  // Explicit reason, so a skipped row is never mistaken for a passing one.
  console.warn(
    `SKIPPED: the hardlink case cannot be reproduced here — link() failed with ${errno} ` +
      '(EXDEV: workspace and panel.db on different devices, or EPERM/EMLINK: link() denied).',
  );
}

realRoot = await realpath(root);

describe('M2.3 — contain-path: the containment function', () => {
  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  describe('validateRelativePath is pure and returns the components', () => {
    it('returns [] for the empty string, which means the root itself', () => {
      expect(validateRelativePath('')).toEqual([]);
    });
    it('splits on "/" and nothing else', () => {
      expect(validateRelativePath('a/b')).toEqual(['a', 'b']);
      expect(validateRelativePath('.claude/settings.json')).toEqual(['.claude', 'settings.json']);
    });
  });

  // -------------------------------------------------------------------------
  describe('syntactic rejection — every row of the docs/FILES.md §2 table', () => {
    const PERSIAN_128 = 'ی'.repeat(128); // 256 bytes: one over the cap
    const PERSIAN_150 = 'ی'.repeat(150); // 300 bytes: the row as FILES.md words it
    const OVER_LONG = Array.from({ length: 17 }, () => 'a'.repeat(255)).join('/'); // 4351 bytes
    const OVER_DEEP = Array.from({ length: 65 }, () => 'd').join('/'); // 65 components

    const rows: Array<[string, PathEscapeCode]> = [
      ['../../panel.db', 'invalid_path'],
      ['../../../etc/passwd', 'invalid_path'],
      ['....//', 'invalid_path'],
      ['..;/', 'invalid_path'],
      ['.../', 'invalid_path'],
      ['/etc/passwd', 'invalid_path'],
      ['C:\\Windows\\win.ini', 'invalid_path'],
      ['dir\\..\\..\\panel.db', 'invalid_path'],
      ['a\x00b', 'invalid_path'],
      ['a\nb', 'invalid_path'],
      ['a\x1b[2Jb', 'invalid_path'],
      ['a\u0085b', 'invalid_path'], // C1: NEL
      ['..', 'invalid_path'],
      ['.', 'invalid_path'],
      ['a//b', 'invalid_path'],
      ['a/', 'invalid_path'],
      ['a ', 'invalid_path'],
      [' a', 'invalid_path'],
      ['a.', 'invalid_path'],
      ['e\u0301', 'invalid_path'], // NFD: the input is not its own NFC form
      [PERSIAN_128, 'invalid_path'],
      [PERSIAN_150, 'invalid_path'],
      [OVER_LONG, 'invalid_path'],
      [OVER_DEEP, 'invalid_path'],
      ['../claude-home/settings.json', 'invalid_path'],
      ['sub/link/../../../panel.db', 'invalid_path'], // invalid by ".." alone
    ];

    for (const [input, code] of rows) {
      it(`refuses ${label(input)} as ${code} without touching the filesystem`, async () => {
        await expectSyntactic(input, code);
      });
    }
  });

  // -------------------------------------------------------------------------
  describe('percent-escapes and "~" are literal names, never syntax', () => {
    // Stated per case: none of these is an escape, and none is decoded or
    // expanded. They resolve inside the root as names that do not exist yet,
    // so the caller produces its own 404 for a read.
    for (const input of ['%2e%2e%2f', '%252e%252e%252f', '~', '~/.ssh/id_ed25519']) {
      it(`${label(input)} resolves as a literal name inside the root`, async () => {
        const resolved = await expectResolve(input, 'read');
        expect(resolved.absolute).toBe(join(realRoot, input));
      });
    }
  });

  // -------------------------------------------------------------------------
  describe('symlinks are refused, not followed — final and intermediate', () => {
    const rows = [
      'db-link',
      'db-link/x', // missing component beneath a symlink
      'passwd-link',
      'passwd-link/x',
      'up-link',
      'up-link/x',
      'outlink',
      'outlink/secret.txt', // would exist if the directory were followed
      'outlink/newfile', // missing component beneath a symlinked directory
      'inside-link', // the tightening: target is INSIDE the root
      'inside-link/x',
      'sub/link',
      'sub/link/x',
    ];

    for (const input of rows) {
      it(`refuses ${input} with code symlink for every intent`, async () => {
        for (const intent of INTENTS) await expectEscape(input, 'symlink', intent);
      });
    }
  });

  // -------------------------------------------------------------------------
  it.skipIf(hardlink === null)(
    'hardlink to panel.db resolves — the residual realpath cannot see',
    async () => {
      const name = hardlink as string;
      const st = await lstat(join(root, name));
      expect(st.isSymbolicLink(), 'a hardlink is an ordinary inode').toBe(false);
      expect(st.nlink, 'two names, one inode').toBe(2);
      const resolved = await expectResolve(name, 'read');
      expect(resolved.absolute).toBe(join(realRoot, name));
      // DOCUMENTED RESIDUAL: containment sees the path, not the alias, so this
      // name reads the database bytes. Mitigated by the workspace being written
      // only by the panel and the agent (both uid 10001), and by mutations being
      // audited with a digest — docs/FILES.md §2's hardlink row.
      expect(await readFile(resolved.absolute, 'utf8')).toBe(PANEL_DB_BYTES);
    },
  );

  // -------------------------------------------------------------------------
  describe('the root itself', () => {
    it('"" with intent list returns the root', async () => {
      const resolved = await expectResolve('', 'list');
      expect(resolved.absolute).toBe(realRoot);
      expect(resolved.relative).toBe('');
    });

    for (const intent of ['read', 'write', 'create'] as const) {
      it(`"" with intent ${intent} is root_not_allowed`, async () => {
        await expectEscape('', 'root_not_allowed', intent);
      });
    }
  });

  // -------------------------------------------------------------------------
  describe('names the operator must still be able to open', () => {
    const rows: Array<[string, PathIntent]> = [
      ['.gitignore', 'read'],
      ['.claude/settings.json', 'read'],
      ['.claude', 'list'],
      ['.a', 'read'], // a leading dot is allowed
      ['file.txt', 'read'],
      ['file.txt', 'write'],
      ['nested/inner.txt', 'read'],
      ['sub', 'list'],
    ];

    for (const [input, intent] of rows) {
      it(`${label(input)} with intent ${intent} resolves inside the root`, async () => {
        const resolved = await expectResolve(input, intent);
        expect(resolved.absolute).toBe(join(realRoot, input));
      });
    }
  });

  // -------------------------------------------------------------------------
  describe('the limits, from the side that is allowed', () => {
    it('PATH_LIMITS are 255 bytes per component, 4096 bytes per path, 64 components', () => {
      expect(PATH_LIMITS).toEqual({ componentBytes: 255, pathBytes: 4096, depth: 64 });
    });

    it('a 127-character Persian component (254 bytes) is allowed', async () => {
      const component = 'ی'.repeat(127);
      expect(validateRelativePath(component)).toEqual([component]);
      const resolved = await expectResolve(component, 'create');
      expect(resolved.absolute).toBe(join(realRoot, component));
    });

    it('a path of exactly 64 components is allowed', async () => {
      const deep = Array.from({ length: 64 }, () => 'd').join('/');
      const resolved = await expectResolve(deep, 'create');
      expect(resolved.absolute).toBe(join(realRoot, deep));
    });

    it('the NFC spelling of an accent is allowed, where the NFD spelling is not', async () => {
      expect(validateRelativePath('é')).toEqual(['é']);
      const resolved = await expectResolve('é', 'create');
      expect(resolved.absolute).toBe(join(realRoot, 'é'));
    });
  });

  // -------------------------------------------------------------------------
  describe('a missing component is not an escape', () => {
    const rows: Array<[string, PathIntent]> = [
      ['nope.txt', 'read'], // returns the would-be path; the caller 404s
      ['nope.txt', 'list'],
      ['nope.txt', 'write'], // creating a new file
      ['newdir/thing.txt', 'create'], // a missing directory segment
      // A file where a directory would be: ENOTDIR is not an escape either, so
      // the path is returned and the caller's own open() reports the failure.
      ['file.txt/child', 'read'],
    ];

    for (const [input, intent] of rows) {
      it(`${label(input)} with intent ${intent} resolves inside the root`, async () => {
        const resolved = await expectResolve(input, intent);
        expect(resolved.absolute).toBe(join(realRoot, input));
      });
    }

    it('a missing segment beneath a symlink is still code symlink', async () => {
      await expectEscape('outlink/brand-new', 'symlink', 'create');
    });
  });

  // -------------------------------------------------------------------------
  describe('the root must be a real directory', () => {
    const symlinkRoot = join(tmp, 'rootlink');
    const fileRoot = join(tmp, 'data', 'panel.db');

    it('a root that is itself a symlink is bad_root', async () => {
      await symlink(realRoot, symlinkRoot).catch(() => undefined);
      expect((await lstat(symlinkRoot)).isSymbolicLink()).toBe(true);
      await escapeAt(symlinkRoot, 'file.txt', 'bad_root', 'read');
    });

    it('a root that is a regular file is bad_root', async () => {
      await escapeAt(fileRoot, 'file.txt', 'bad_root', 'read');
    });
  });

  // -------------------------------------------------------------------------
  it('refuses the syntax before any filesystem call, even when the root does not exist', async () => {
    const missingRoot = join(tmp, 'never-created', 'workspace');
    // The contrast: for a syntactically valid path the same root reports
    // bad_root, so invalid_path below cannot be a second-hand bad_root.
    await escapeAt(missingRoot, 'file.txt', 'bad_root', 'read');
    await escapeAt(missingRoot, '../../panel.db', 'invalid_path', 'read');
    await escapeAt(missingRoot, 'a\x00b', 'invalid_path', 'read');
    // And the root check precedes the root-intent check: step 2 before step 5.
    await escapeAt(missingRoot, '', 'bad_root', 'read');
  });

  // -------------------------------------------------------------------------
  describe('error hygiene', () => {
    const codes: PathEscapeCode[] = [
      'invalid_path',
      'outside_root',
      'symlink',
      'root_not_allowed',
      'bad_root',
    ];

    it('gives each code its own fixed message, carrying no path, input or errno', () => {
      const messages = codes.map((code) => new PathEscape(code).message);
      expect(new Set(messages).size).toBe(codes.length);
      for (const message of messages) {
        expect(message).not.toContain(sep);
        expect(message).not.toContain('\\');
        expect(message).not.toContain('\n');
        expect(message).not.toContain('ENOENT');
        expect(message).not.toContain(tmp);
      }
    });
  });

  // -------------------------------------------------------------------------
  it('keeps the claude-home settings file beside the workspace unreachable', async () => {
    // The target exists — otherwise "unreachable" would be vacuous.
    const settings = join(project, 'claude-home', 'settings.json');
    expect(await readFile(settings, 'utf8')).toBe(SENTINEL);

    const hostile: Array<[string, PathEscapeCode]> = [
      ['../claude-home/settings.json', 'invalid_path'],
      ['../../claude-home/settings.json', 'invalid_path'],
      ['up-link', 'symlink'],
      ['up-link/x', 'symlink'],
      ['sub/link/claude-home/settings.json', 'symlink'],
      ['sub/link/../../../claude-home/settings.json', 'invalid_path'],
    ];
    for (const [input, code] of hostile) await expectEscape(input, code);

    // Every path that WAS accepted was asserted inside realRoot by
    // expectResolve, and claude-home is a sibling of the workspace, so no
    // accepted absolute path can name it.
    expect(settings.startsWith(join(realRoot, '..'))).toBe(true);
  });
});
