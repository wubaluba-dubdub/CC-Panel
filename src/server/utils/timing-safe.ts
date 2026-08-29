import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string equality.
 *
 * Length is compared first and leaks: `crypto.timingSafeEqual` throws on
 * mismatched buffer lengths, so there is no way to avoid it, and for every
 * caller here the length is already public (the generated base path is always
 * 22 characters, documented in CLAUDE.md). What this buys is that *content*
 * comparison never short-circuits: `a === b` and `String.prototype.startsWith`
 * both bail on the first differing byte, which is what makes a secret
 * guessable one character at a time.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  if (left.length === 0) return true;
  return timingSafeEqual(left, right);
}

/**
 * The first path segment of a pathname, without the leading slash.
 *
 * Returns `null` when the input is not in origin-form (does not start with
 * `/`) — for example the absolute-form URL a misconfigured forward proxy can
 * produce. Callers must treat `null` as "no match".
 *
 * The scan length depends on the segment's length, never on its content.
 */
export function firstPathSegment(pathname: string): string | null {
  if (pathname.charCodeAt(0) !== 0x2f /* '/' */) return null;
  const end = pathname.indexOf('/', 1);
  return end === -1 ? pathname.slice(1) : pathname.slice(1, end);
}

/** Strips the query string from a raw request URL. Node never sends a fragment. */
export function pathnameOf(rawUrl: string): string {
  const q = rawUrl.indexOf('?');
  return q === -1 ? rawUrl : rawUrl.slice(0, q);
}
