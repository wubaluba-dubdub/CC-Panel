import { describe, expect, it } from 'vitest';
import { InvalidSlugError, SLUG_PATTERN, canonicalizeSlug } from '../../src/server/utils/project-slug.js';

describe('SLUG_PATTERN', () => {
  it('accepts the canonical grammar exactly', () => {
    // 'a--b' is inside the grammar: the middle class admits consecutive hyphens.
    for (const good of ['ab', 'a-b', 'a2-9z', 'a--b', 'a'.repeat(40)])
      expect(SLUG_PATTERN.test(good), JSON.stringify(good)).toBe(true);
  });

  it('rejects the boundaries the grammar forbids', () => {
    for (const bad of ['', 'a', '-ab', 'ab-', 'a'.repeat(41), 'a_b', 'a b', 'a.b', 'äb', 'A'])
      expect(SLUG_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('canonicalizeSlug', () => {
  it('returns a canonical slug unchanged', () => {
    expect(canonicalizeSlug('alpha-9')).toBe('alpha-9');
  });

  it('applies NFC normalisation before validation', () => {
    // A + combining diaeresis composes to Ä; the error names the composed form,
    // which is only visible if NFC ran before the grammar check.
    expect(() => canonicalizeSlug('A\u0308b')).toThrow(/Ä/);
  });

  it('ASCII-case-folds — and that is the only folding it does', () => {
    expect(canonicalizeSlug('AlPhA-2B')).toBe('alpha-2b');
    // Non-ASCII is never transliterated in: NFC leaves these non-ASCII, and no
    // amount of case folding would make them grammar-valid.
    expect(() => canonicalizeSlug('Älpha')).toThrow(InvalidSlugError);
    expect(() => canonicalizeSlug('alpha-ı')).toThrow(InvalidSlugError);
  });

  it('admits canonically-equivalent input: U+212A KELVIN SIGN NFC-decomposes to K', () => {
    // The one non-ASCII character NFC maps to ASCII. It enters through
    // normalisation, not folding — this is migration 012's "unique after NFC
    // normalisation and case folding" made concrete.
    expect(canonicalizeSlug('\u212Aey')).toBe('key');
    expect(canonicalizeSlug('Key')).toBe('key');
  });

  it('rejects empty, whitespace, non-strings, and hyphen/length edges', () => {
    expect(() => canonicalizeSlug('')).toThrow(/empty/);
    expect(() => canonicalizeSlug(' alpha')).toThrow(InvalidSlugError);
    expect(() => canonicalizeSlug('al pha')).toThrow(InvalidSlugError);
    expect(() => canonicalizeSlug(42 as unknown as string)).toThrow(/must be a string/);
    expect(() => canonicalizeSlug(null as unknown as string)).toThrow(InvalidSlugError);
    for (const bad of ['-ab', 'ab-', 'a', 'a-'])
      expect(() => canonicalizeSlug(bad)).toThrow(InvalidSlugError);
    expect(() => canonicalizeSlug('A'.repeat(41))).toThrow(/maximum is 40/);
  });

  it('measures length on the canonical value', () => {
    expect(canonicalizeSlug('A'.repeat(40))).toBe('a'.repeat(40));
  });
});
