import { describe, it, expect } from 'vitest';
import {
  firstPathSegment,
  pathnameOf,
  timingSafeEqualStrings,
} from '../../src/server/utils/timing-safe.js';
import { createBasePathGate, NOT_FOUND_SINK } from '../../src/server/plugins/base-path.js';
import type { IncomingMessage } from 'node:http';

const req = (url: string | undefined): IncomingMessage => ({ url }) as IncomingMessage;

describe('timingSafeEqualStrings', () => {
  it('matches equal strings', () => {
    expect(timingSafeEqualStrings('correct-horse', 'correct-horse')).toBe(true);
    expect(timingSafeEqualStrings('', '')).toBe(true);
  });

  it('rejects strings that differ in content but not length', () => {
    expect(timingSafeEqualStrings('correct-horse', 'correct-horsE')).toBe(false);
    expect(timingSafeEqualStrings('correct-horse', 'Xorrect-horse')).toBe(false);
  });

  it('rejects strings of different length instead of throwing', () => {
    // crypto.timingSafeEqual throws on mismatched lengths; the length check has
    // to come first.
    expect(timingSafeEqualStrings('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualStrings('abcd', 'abc')).toBe(false);
    expect(timingSafeEqualStrings('abc', '')).toBe(false);
  });

  it('compares bytes, not code units', () => {
    expect(timingSafeEqualStrings('é', 'é')).toBe(true);
    expect(timingSafeEqualStrings('é', 'e')).toBe(false);
  });
});

describe('firstPathSegment', () => {
  it('extracts the first segment', () => {
    expect(firstPathSegment('/abc')).toBe('abc');
    expect(firstPathSegment('/abc/')).toBe('abc');
    expect(firstPathSegment('/abc/def/ghi')).toBe('abc');
    expect(firstPathSegment('/')).toBe('');
  });

  it('returns null for anything not in origin-form', () => {
    expect(firstPathSegment('http://host/abc')).toBeNull();
    expect(firstPathSegment('abc')).toBeNull();
    expect(firstPathSegment('')).toBeNull();
  });
});

describe('pathnameOf', () => {
  it('strips the query string', () => {
    expect(pathnameOf('/abc?x=1')).toBe('/abc');
    expect(pathnameOf('/abc')).toBe('/abc');
    expect(pathnameOf('/abc?')).toBe('/abc');
    expect(pathnameOf('?x=1')).toBe('');
  });
});

describe('createBasePathGate', () => {
  const gate = createBasePathGate('correct-base-path');

  it('passes the base path through untouched', () => {
    // Untouched rather than rewritten onto an internal mount, so redirects and
    // static-file links keep pointing at URLs a browser can follow.
    expect(gate(req('/correct-base-path'))).toBe('/correct-base-path');
    expect(gate(req('/correct-base-path/'))).toBe('/correct-base-path/');
    expect(gate(req('/correct-base-path/a/b?c=d'))).toBe('/correct-base-path/a/b?c=d');
  });

  it('passes /healthz through untouched', () => {
    expect(gate(req('/healthz'))).toBe('/healthz');
  });

  it('collapses every other path onto one sink URL', () => {
    const rejected = [
      '/',
      '/healthzz',
      '/healthz/x',
      '/c',
      '/correct-base-pat',
      '/correct-base-pathX',
      '/correct-base-path-longer',
      '/Correct-Base-Path',
      '/%63orrect-base-path',
      '/correct-base-path2/x',
      'http://host/correct-base-path',
      undefined,
    ];

    for (const url of rejected) {
      expect(gate(req(url)), String(url)).toBe(NOT_FOUND_SINK);
    }
  });

  it('rewrites a request for the sink URL itself to the sink URL', () => {
    expect(gate(req(NOT_FOUND_SINK))).toBe(NOT_FOUND_SINK);
  });

  it('gates the raw URL, without resolving dot-segments', () => {
    // Node's HTTP parser hands over the request target verbatim — it does not
    // collapse `..`. Asserted here rather than through app.inject(), because
    // light-my-request normalises the URL before Fastify ever sees it, so the
    // integration layer cannot express a non-normalised request target.
    expect(gate(req('/wrong/../correct-base-path/'))).toBe(NOT_FOUND_SINK);
    expect(gate(req('/./correct-base-path/'))).toBe(NOT_FOUND_SINK);
    expect(gate(req('/correct-base-path/../wrong'))).toBe('/correct-base-path/../wrong');
  });
});
