import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  CryptoNotInitializedError,
  DecryptionError,
  KeyPurpose,
  PayloadFormatError,
  columnAad,
  decrypt,
  deriveSubkey,
  encrypt,
  initCrypto,
  isCryptoInitialized,
  resetCrypto,
} from '../../src/server/crypto.js';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

const AAD = columnAad('secrets', 1, 'payload');

/** Re-encodes one part of a `v1.<nonce>.<ciphertext>.<tag>` payload with a single byte flipped. */
function flipByteInPart(payload: string, partIndex: 1 | 2 | 3, byteIndex = 0): string {
  const parts = payload.split('.');
  const raw = Buffer.from(parts[partIndex]!, 'base64url');
  raw[byteIndex] = raw[byteIndex]! ^ 0x01;
  parts[partIndex] = raw.toString('base64url');
  return parts.join('.');
}

describe('key derivation', () => {
  beforeEach(() => {
    resetCrypto();
    initCrypto(KEY_A);
  });

  it('derives a 32-byte subkey', () => {
    expect(deriveSubkey(KeyPurpose.SecretColumn)).toHaveLength(32);
  });

  it('is deterministic for the same label and master key', () => {
    const first = Buffer.from(deriveSubkey('label/one'));
    resetCrypto();
    initCrypto(KEY_A);
    expect(deriveSubkey('label/one').equals(first)).toBe(true);
  });

  it('gives a different subkey per info label', () => {
    const one = Buffer.from(deriveSubkey('label/one'));
    const two = Buffer.from(deriveSubkey('label/two'));
    expect(one.equals(two)).toBe(false);
  });

  it('gives a different subkey per master key', () => {
    const underA = Buffer.from(deriveSubkey('label/one'));
    resetCrypto();
    initCrypto(KEY_B);
    expect(deriveSubkey('label/one').equals(underA)).toBe(false);
  });

  it('never returns the master key itself', () => {
    const master = Buffer.from(KEY_A, 'base64');
    expect(deriveSubkey(KeyPurpose.SecretColumn).equals(master)).toBe(false);
  });

  it('refuses to derive before initialization', () => {
    resetCrypto();
    expect(isCryptoInitialized()).toBe(false);
    expect(() => deriveSubkey(KeyPurpose.SecretColumn)).toThrow(CryptoNotInitializedError);
  });

  it('rejects a master key shorter than 32 bytes', () => {
    expect(() => initCrypto(randomBytes(16).toString('base64'))).toThrow(/at least 32 bytes/);
  });
});

describe('columnAad', () => {
  it('binds table, row and column', () => {
    expect(columnAad('secrets', 42, 'payload')).toBe('secrets:42:payload');
  });

  it('rejects parts that would make the AAD ambiguous', () => {
    expect(() => columnAad('sec:rets', 1, 'payload')).toThrow(/must not contain/);
    expect(() => columnAad('secrets', 1, 'pay:load')).toThrow(/must not contain/);
    expect(() => columnAad('', 1, 'payload')).toThrow(/must not be empty/);
  });
});

describe('encrypt / decrypt', () => {
  beforeEach(() => {
    resetCrypto();
    initCrypto(KEY_A);
  });

  it('round-trips plaintext', () => {
    const plaintext = 'sk-ant-api03-round-trip-value';
    expect(decrypt(encrypt(plaintext, AAD), AAD)).toBe(plaintext);
  });

  it('round-trips an empty string and multi-byte UTF-8', () => {
    expect(decrypt(encrypt('', AAD), AAD)).toBe('');
    expect(decrypt(encrypt('کلید — 🔐', AAD), AAD)).toBe('کلید — 🔐');
  });

  it('produces the documented self-describing format', () => {
    const payload = encrypt('value', AAD);
    const parts = payload.split('.');

    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(Buffer.from(parts[1]!, 'base64url')).toHaveLength(12); // 96-bit nonce
    expect(Buffer.from(parts[3]!, 'base64url')).toHaveLength(16); // 128-bit tag
    // base64url only: no +, /, or = padding.
    expect(payload).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/);
  });

  it('produces a different ciphertext every time for the same plaintext', () => {
    const payloads = new Set(Array.from({ length: 20 }, () => encrypt('same value', AAD)));
    expect(payloads.size).toBe(20);

    const nonces = new Set([...payloads].map((p) => p.split('.')[1]));
    expect(nonces.size).toBe(20);
  });

  it('fails when the AAD does not match', () => {
    const payload = encrypt('value', columnAad('secrets', 1, 'payload'));

    // Different row.
    expect(() => decrypt(payload, columnAad('secrets', 2, 'payload'))).toThrow(DecryptionError);
    // Different column.
    expect(() => decrypt(payload, columnAad('secrets', 1, 'other'))).toThrow(DecryptionError);
    // Different table.
    expect(() => decrypt(payload, columnAad('users', 1, 'payload'))).toThrow(DecryptionError);
  });

  it('fails when the nonce is altered by a single byte', () => {
    const payload = encrypt('value', AAD);
    expect(() => decrypt(flipByteInPart(payload, 1), AAD)).toThrow(DecryptionError);
  });

  it('fails when the ciphertext is altered by a single byte', () => {
    const payload = encrypt('a plaintext long enough to flip a byte in', AAD);
    expect(() => decrypt(flipByteInPart(payload, 2), AAD)).toThrow(DecryptionError);
  });

  it('fails when the tag is altered by a single byte', () => {
    const payload = encrypt('value', AAD);
    expect(() => decrypt(flipByteInPart(payload, 3), AAD)).toThrow(DecryptionError);
  });

  it('fails under a different master key', () => {
    const payload = encrypt('value', AAD);
    resetCrypto();
    initCrypto(KEY_B);
    expect(() => decrypt(payload, AAD)).toThrow(DecryptionError);
  });

  it('rejects an unknown version prefix instead of guessing', () => {
    const payload = encrypt('value', AAD);
    const parts = payload.split('.');

    // `v2` is no longer in this list: migration 009 introduced it for the
    // `(scope, name)`-bound secrets AAD. The list is every spelling that is still not a
    // version, including the two that look like one.
    for (const version of ['v0', 'v3', 'v11', 'V1', '1', '']) {
      const forged = [version, ...parts.slice(1)].join('.');
      expect(() => decrypt(forged, AAD), version).toThrow(PayloadFormatError);
    }
  });

  it('rejects a malformed payload', () => {
    for (const bad of ['', 'v1', 'v1.a.b', 'v1.a.b.c.d', 'not-a-payload']) {
      expect(() => decrypt(bad, AAD), JSON.stringify(bad)).toThrow(PayloadFormatError);
    }
  });

  it('rejects a wrong-length nonce or tag before attempting decryption', () => {
    const parts = encrypt('value', AAD).split('.');

    const shortNonce = ['v1', randomBytes(8).toString('base64url'), parts[2], parts[3]].join('.');
    expect(() => decrypt(shortNonce, AAD)).toThrow(PayloadFormatError);

    const shortTag = ['v1', parts[1], parts[2], randomBytes(8).toString('base64url')].join('.');
    expect(() => decrypt(shortTag, AAD)).toThrow(PayloadFormatError);
  });

  it('reports every authentication failure identically', () => {
    const payload = encrypt('value', AAD);
    const messages = new Set<string>();

    for (const attempt of [
      () => decrypt(payload, columnAad('secrets', 999, 'payload')),
      () => decrypt(flipByteInPart(payload, 2), AAD),
      () => decrypt(flipByteInPart(payload, 3), AAD),
    ]) {
      try {
        attempt();
        throw new Error('expected a failure');
      } catch (err) {
        messages.add((err as Error).message);
      }
    }

    // A caller must not be able to tell which input was wrong.
    expect(messages).toEqual(new Set(['decryption failed']));
  });
});
