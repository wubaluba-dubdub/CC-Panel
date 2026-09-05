import { describe, it, expect } from 'vitest';
import { localeFromAcceptLanguage } from '../../src/server/utils/accept-language.js';

/**
 * The one locale decision the server makes, and it is a guess rather than a translation.
 *
 * It exists so `bootstrap.js` can set `documentElement.dir` **before first paint**: a client
 * that decided for itself could only do so after its bundle had parsed, which is one frame of
 * left-to-right on a Persian page. The header is attacker-controllable input, so the parser is
 * small, bounded, and total.
 */
describe('the first locale guess', () => {
  it('reads a plain tag, with or without a region', () => {
    expect(localeFromAcceptLanguage('fa')).toBe('fa');
    expect(localeFromAcceptLanguage('fa-IR')).toBe('fa');
    expect(localeFromAcceptLanguage('en-GB')).toBe('en');
  });

  it('honours quality values rather than order alone', () => {
    expect(localeFromAcceptLanguage('en;q=0.9, fa;q=0.8')).toBe('en');
    expect(localeFromAcceptLanguage('en;q=0.5, fa;q=0.9')).toBe('fa');
    // A real Chrome header from an Iranian machine.
    expect(localeFromAcceptLanguage('fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7')).toBe('fa');
  });

  it('breaks a tie on the order the client wrote, which is what a browser means', () => {
    expect(localeFromAcceptLanguage('fa,en')).toBe('fa');
    expect(localeFromAcceptLanguage('en,fa')).toBe('en');
    expect(localeFromAcceptLanguage('fa;q=0.8,en;q=0.8')).toBe('fa');
  });

  it('treats q=0 as a refusal rather than a weak preference', () => {
    expect(localeFromAcceptLanguage('fa;q=0, en;q=0.1')).toBe('en');
  });

  it('accepts the other spellings of Persian, and nothing it cannot render', () => {
    // Dari is Persian in a different orthography, and `pes` is Iranian Persian's ISO-639-3
    // code. A tag the panel has no dictionary for is not guessed at from its script subtag.
    expect(localeFromAcceptLanguage('prs')).toBe('fa');
    expect(localeFromAcceptLanguage('pes-AF')).toBe('fa');
    expect(localeFromAcceptLanguage('ar-SA')).toBe('en');
    expect(localeFromAcceptLanguage('ur-PK,ps;q=0.9')).toBe('en');
  });

  it('falls back to English for anything absent, empty or unparseable', () => {
    expect(localeFromAcceptLanguage(undefined)).toBe('en');
    expect(localeFromAcceptLanguage('')).toBe('en');
    expect(localeFromAcceptLanguage('*')).toBe('en');
    expect(localeFromAcceptLanguage(';;;q=')).toBe('en');
    expect(localeFromAcceptLanguage('fa;q=abc')).toBe('fa');
    // An array is what Node produces for a duplicated header, and a number is what a
    // hand-built client can send.
    expect(localeFromAcceptLanguage(['fa', 'en'])).toBe('en');
    expect(localeFromAcceptLanguage(42)).toBe('en');
  });

  it('is bounded, because the header is attacker-controllable', () => {
    // Not a parser worth spending time in. A header past any real browser's length is
    // truncated rather than walked.
    const flood = `${'fa,'.repeat(5000)}en`;
    expect(localeFromAcceptLanguage(flood)).toBe('fa');
    expect(localeFromAcceptLanguage(`${'x'.repeat(10_000)},fa`)).toBe('en');
  });
});
