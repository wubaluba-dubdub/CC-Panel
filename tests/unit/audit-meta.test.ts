import { describe, it, expect } from 'vitest';
import {
  META_INLINE_PAIRS,
  META_VALUE_CAP,
  metaPairs,
  rawMeta,
} from '../../src/client/lib/meta.js';

/**
 * An audit row's metadata, as pairs.
 *
 * The screen used to render `JSON.stringify(entry.meta)` into a table cell, which is how the
 * detail column ended up wider than the card that contained it. Two properties are asserted here:
 * every value is bounded, and the raw form is *exactly* what the row holds — because that is the
 * string an operator compares with a backup or with a log line, and a pretty-printed
 * approximation of it would not match.
 */

describe('metadata becomes pairs', () => {
  it('keeps the keys untranslated, in the order the row carries them', () => {
    // Grep keys. The `sessionId` on this screen has to be the `sessionId` in a Telegram message
    // and in a Railway log line.
    expect(metaPairs({ sessionId: 1, viaEnrollment: true })).toEqual([
      { key: 'sessionId', value: '1', truncated: false },
      { key: 'viaEnrollment', value: 'true', truncated: false },
    ]);
  });

  it('formats each value by its type, and null is the word rather than an absence', () => {
    expect(metaPairs({ a: 'text', b: 12, c: false, d: null })).toEqual([
      { key: 'a', value: 'text', truncated: false },
      { key: 'b', value: '12', truncated: false },
      { key: 'c', value: 'false', truncated: false },
      { key: 'd', value: 'null', truncated: false },
    ]);
  });

  it('caps a long value and says that it did', () => {
    const long = 'x'.repeat(META_VALUE_CAP + 50);
    const [pair] = metaPairs({ reason: long });
    expect(pair!.truncated).toBe(true);
    expect([...pair!.value].length).toBe(META_VALUE_CAP + 1);
    expect(pair!.value.endsWith('…')).toBe(true);
  });

  it('caps by code point, so a truncation cannot split a character in half', () => {
    // An emoji is two UTF-16 units. Slicing by unit would leave a lone surrogate on the screen,
    // which renders as a replacement character and reads as corruption.
    const emoji = '😀'.repeat(META_VALUE_CAP + 10);
    const [pair] = metaPairs({ note: emoji });
    expect(pair!.value).not.toContain('�');
    expect([...pair!.value].every((point) => point === '😀' || point === '…')).toBe(true);
  });

  it('stringifies a nested value rather than rendering an object', () => {
    // The server refuses non-primitive metadata, so this is defence for a client handed a parsed
    // response body rather than a promise about one.
    const [pair] = metaPairs({ nested: { a: [1, 2] } });
    expect(pair!.value).toBe('{"a":[1,2]}');
  });

  it('returns nothing for a shape that is not an object', () => {
    for (const notAnObject of [null, undefined, 3, 'text', [1, 2], true]) {
      expect(metaPairs(notAnObject)).toEqual([]);
    }
  });

  it('caps a hostile key as well as a hostile value', () => {
    const [pair] = metaPairs({ [`k${'e'.repeat(META_VALUE_CAP * 2)}y`]: 1 });
    expect([...pair!.key].length).toBe(META_VALUE_CAP + 1);
  });

  it('shows a small number of pairs inline, which is what the expander is for', () => {
    expect(META_INLINE_PAIRS).toBeGreaterThan(0);
    expect(META_INLINE_PAIRS).toBeLessThan(6);
  });
});

describe('the raw form is the stored form', () => {
  it('is compact JSON, byte for byte what `meta_json` holds', () => {
    const meta = { sessionId: 1, viaEnrollment: true };
    expect(rawMeta(meta)).toBe(JSON.stringify(meta));
    expect(rawMeta(meta)).toBe('{"sessionId":1,"viaEnrollment":true}');
  });

  it('is not truncated, because it is the thing the operator compares', () => {
    const long = 'x'.repeat(META_VALUE_CAP * 4);
    expect(rawMeta({ reason: long })).toContain(long);
  });

  it('answers `null` rather than an empty string for an empty row', () => {
    expect(rawMeta(null)).toBe('null');
    expect(rawMeta({})).toBe('{}');
  });
});
