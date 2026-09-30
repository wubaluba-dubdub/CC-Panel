import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

/**
 * Path containment — the whole of R4's security argument (docs/FILES.md §2).
 *
 * One implementation, because docs/IMPORT.md §3.1 and docs/PORTABILITY.md §7.1
 * both name this exact function as the one they reuse: writing a second
 * containment check for imports is explicitly not acceptable. Every route must
 * call `resolveInProject` before any I/O.
 *
 * The order of the steps is the feature:
 *
 * 1. The syntactic rules run first and touch no filesystem, so a traversal is
 *    refused without even revealing whether the root exists.
 * 2. The root must be a real directory (`lstat`, never a symlink) and is
 *    `realpath`'ed exactly once; every assertion below is made against that
 *    resolved root, so a symlinked parent cannot shift it.
 * 3. Each component is `lstat`'ed in turn, and a symlink anywhere —
 *    intermediate or final, pointing inside the root or out of it — is refused
 *    rather than followed. This is deliberately tighter than FILES.md §2, which
 *    names only the final component: a listing never crosses into a symlinked
 *    directory, so no operator need is served by traversing one, and refusing
 *    the whole class removes the question instead of answering it case by case.
 * 4. The deepest existing prefix is `realpath`'ed and asserted to be inside the
 *    resolved root, which is what catches a component replaced by a symlink
 *    between the walk and that line.
 *
 * Only `lstat` and `realpath` are used: the plain variant follows symlinks and
 * would make step 3 blind. Percent-escapes are never decoded and `~` is never
 * expanded, so `%2e%2e%2f` and `~` are ordinary literal filenames — the outcome
 * the adversarial table demands, and the reason neither is a special case here.
 *
 * A missing component is not an escape. For `list` and `read` the would-be
 * absolute path is returned so the caller produces its own 404; for `create`
 * and `write` it is where the new file goes. Either way the component was
 * checked syntactically and everything above it was checked on disk.
 *
 * What this does not do is hold the path open: between this return and the
 * caller's `open` there is a window (TOCTOU), so the caller must open with
 * `O_NOFOLLOW` for the guarantee to survive it.
 */

export type PathIntent = 'list' | 'read' | 'write' | 'create';

export type PathEscapeCode =
  | 'invalid_path'
  | 'outside_root'
  | 'symlink'
  | 'root_not_allowed'
  | 'bad_root';

/**
 * Fixed text per code, and nothing else ever reaches `Error.message`: never the
 * root, the path, the user's input, or a filesystem error's own words. A
 * containment failure is logged and rendered, so an interpolated path would be
 * an unvalidated string in an audit row and in an operator's browser.
 */
const MESSAGE: Readonly<Record<PathEscapeCode, string>> = {
  invalid_path: 'invalid path',
  outside_root: 'outside root',
  symlink: 'symlink refused',
  root_not_allowed: 'root itself is refused',
  bad_root: 'bad root',
};

/** The only error this module throws. `code` is what a caller may branch on. */
export class PathEscape extends Error {
  readonly code: PathEscapeCode;

  constructor(code: PathEscapeCode) {
    super(MESSAGE[code]);
    this.name = 'PathEscape';
    this.code = code;
  }
}

/** NUL and C0, then DEL and C1 — matched against the raw input, first of all. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Kernel limits, in bytes: ext4 counts bytes while a UI counts characters. */
export const PATH_LIMITS = {
  componentBytes: 255,
  pathBytes: 4096,
  depth: 64,
} as const;

/** The errno of a filesystem rejection, or undefined when it carries none. */
function errnoOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const code: unknown = (err as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

type Step =
  | { kind: 'ok'; symlink: boolean; directory: boolean }
  | { kind: 'missing' }
  | { kind: 'denied' };

/**
 * `lstat`, classified. Never the following variant: not following the symlink
 * is the whole point of the walk below. ENOENT and ENOTDIR mean "not here",
 * which is not an escape; every other errno fails closed as `denied`.
 */
async function probe(path: string): Promise<Step> {
  try {
    const st = await lstat(path);
    return { kind: 'ok', symlink: st.isSymbolicLink(), directory: st.isDirectory() };
  } catch (err) {
    const code = errnoOf(err);
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'denied' };
  }
}

/** Canonical path, or null on any failure — including a path that vanished mid-check. */
async function realpathOf(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * Splits a relative path into components, or throws `PathEscape('invalid_path')`.
 *
 * Pure and synchronous: it touches no filesystem, which is what lets
 * `resolveInProject` refuse a traversal before learning whether the root
 * exists at all.
 *
 * A **leading** dot is allowed — `.gitignore`, `.env.example` and
 * `.claude/settings.json` are files the operator must be able to open, and
 * reading the rejection list as "no leading dot" would break the feature it is
 * securing. What is refused is the Windows rule: a trailing dot or space, on a
 * leading space, because `file.` and `file` are one file to a Windows client
 * and a name starting with a space is invisible in a listing.
 */
export function validateRelativePath(userPath: string): string[] {
  if (typeof userPath !== 'string') throw new PathEscape('invalid_path');
  if (CONTROL.test(userPath)) throw new PathEscape('invalid_path');
  // Two spellings of one path would defeat any check performed on the text.
  if (userPath !== userPath.normalize('NFC')) throw new PathEscape('invalid_path');
  // "" is the root itself: the one empty input that is accepted.
  if (userPath === '') return [];
  if (userPath.startsWith('/')) throw new PathEscape('invalid_path');
  // A backslash is a legal filename byte here and a separator to a Windows
  // client; the two would disagree about where the path lands.
  if (userPath.includes('\\')) throw new PathEscape('invalid_path');
  if (Buffer.byteLength(userPath, 'utf8') > PATH_LIMITS.pathBytes) {
    throw new PathEscape('invalid_path');
  }

  const parts = userPath.split('/');
  if (parts.length > PATH_LIMITS.depth) throw new PathEscape('invalid_path');

  for (const part of parts) {
    if (part === '') throw new PathEscape('invalid_path');
    if (part === '.' || part === '..') throw new PathEscape('invalid_path');
    if (part.startsWith(' ') || part.endsWith(' ') || part.endsWith('.')) {
      throw new PathEscape('invalid_path');
    }
    // Bytes, not characters: a Persian filename is two bytes per character.
    if (Buffer.byteLength(part, 'utf8') > PATH_LIMITS.componentBytes) {
      throw new PathEscape('invalid_path');
    }
  }
  return parts;
}

/**
 * Resolves `userPath` inside `root`, or throws `PathEscape` saying why.
 *
 * @throws {PathEscape} `invalid_path` — syntax, before any filesystem call.
 * @throws {PathEscape} `bad_root` — the root is missing, not a directory, or a symlink.
 * @throws {PathEscape} `symlink` — some component is a symlink, intermediate or final.
 * @throws {PathEscape} `outside_root` — the deepest existing prefix resolves
 * outside the root, or the filesystem refused the walk.
 * @throws {PathEscape} `root_not_allowed` — the root itself, for an intent that
 * names a file rather than a listing.
 */
export async function resolveInProject(
  root: string,
  userPath: string,
  intent: PathIntent,
): Promise<{ absolute: string; relative: string }> {
  // 1. Syntax first, with no filesystem call at all.
  const parts = validateRelativePath(userPath);

  // 2. The root, resolved once: a real directory, never a symlink itself.
  const rootStep = await probe(root);
  if (rootStep.kind !== 'ok' || !rootStep.directory || rootStep.symlink) {
    throw new PathEscape('bad_root');
  }
  const realRoot = await realpathOf(root);
  if (realRoot === null) throw new PathEscape('bad_root');

  // 3. Walk the components, refusing every symlink met on the way.
  let base = realRoot;
  let existing = 0;
  for (const part of parts) {
    const next = join(base, part);
    const step = await probe(next);
    if (step.kind === 'missing') break; // syntactically checked only, from here
    if (step.kind === 'denied') throw new PathEscape('outside_root'); // fail closed
    if (step.symlink) throw new PathEscape('symlink');
    base = next;
    existing += 1;
  }

  // 4. The deepest existing prefix: resolved, then asserted to be inside.
  if (existing > 0) {
    const resolved = await realpathOf(base);
    if (resolved === null) throw new PathEscape('outside_root');
    if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) {
      throw new PathEscape('outside_root');
    }
    base = resolved;
  }

  // 5. The root itself: a listing of it is the feature, a write to it is not.
  if (parts.length === 0) {
    if (intent !== 'list') throw new PathEscape('root_not_allowed');
    return { absolute: realRoot, relative: '' };
  }

  // A missing tail is returned as-is: the caller 404s for list/read and
  // creates for create/write. It was checked syntactically above.
  const absolute = existing === parts.length ? base : join(base, ...parts.slice(existing));
  return { absolute, relative: parts.join('/') };
}
