import { describe, it, expect, afterEach } from 'vitest';
import { getDb } from '../../src/server/db.js';
import {
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_ENTROPY_BITS,
  RecoveryCodesService,
  canonicaliseRecoveryCode,
} from '../../src/server/services/recovery-codes.service.js';
import { SINGLE_USER_ID } from '../../src/server/services/user.service.js';
import { createTestServer, type TestContext } from '../helpers/test-server.js';
import { FakeClock } from '../helpers/fake-clock.js';

function service(): RecoveryCodesService {
  return new RecoveryCodesService({ db: getDb(), clock: new FakeClock() });
}

describe('M1.4 — recovery codes', () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  describe('shape', () => {
    it('draws from a 32-symbol alphabet with no confusable pairs', () => {
      // Exactly 32, or masking a byte to five bits would be biased.
      expect(RECOVERY_CODE_ALPHABET.length).toBe(32);
      expect(new Set(RECOVERY_CODE_ALPHABET).size).toBe(32);
      // Never both members of a confusable pair.
      expect(RECOVERY_CODE_ALPHABET).not.toContain('0');
      expect(RECOVERY_CODE_ALPHABET).not.toContain('O');
      expect(RECOVERY_CODE_ALPHABET).not.toContain('1');
      expect(RECOVERY_CODE_ALPHABET).not.toContain('I');
      expect(RECOVERY_CODE_ENTROPY_BITS).toBe(50);
    });

    it('issues exactly ten grouped codes', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const codes = await service().regenerate();

      expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
      expect(RECOVERY_CODE_COUNT).toBe(10);
      for (const code of codes) {
        expect(code.reveal()).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
        // A SecretString, so it cannot reach a log line by being interpolated.
        expect(`${code}`).toBe('[redacted]');
      }
      // All distinct.
      expect(new Set(codes.map((c) => c.reveal())).size).toBe(RECOVERY_CODE_COUNT);
    });

    it('normalises case and formatting', () => {
      expect(canonicaliseRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
      expect(canonicaliseRecoveryCode(' ABCDE FGHJK ')).toBe('ABCDEFGHJK');
      expect(canonicaliseRecoveryCode('ABCDEFGHJK')).toBe('ABCDEFGHJK');
    });
  });

  describe('storage', () => {
    it('stores only argon2 hashes, never the code', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const codes = await service().regenerate();

      const rows = getDb()
        .prepare('SELECT code_hash FROM recovery_codes WHERE user_id = ?')
        .all(SINGLE_USER_ID) as { code_hash: string }[];

      expect(rows).toHaveLength(RECOVERY_CODE_COUNT);
      for (const row of rows) {
        expect(row.code_hash.startsWith('$argon2id$')).toBe(true);
        for (const code of codes) {
          expect(row.code_hash).not.toContain(code.reveal());
          expect(row.code_hash).not.toContain(canonicaliseRecoveryCode(code.reveal()));
        }
      }
    });

    it('keeps the user row count in step', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const svc = service();
      const codes = await svc.regenerate();

      expect(svc.remaining()).toBe(10);
      expect(storedCount()).toBe(10);

      await svc.consume(codes[0]!.reveal());
      expect(svc.remaining()).toBe(9);
      expect(storedCount()).toBe(9);
    });
  });

  describe('single use', () => {
    it('accepts a code exactly once', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const svc = service();
      const codes = await svc.regenerate();
      const code = codes[3]!.reveal();

      expect(await svc.consume(code)).toBe(true);
      expect(await svc.consume(code)).toBe(false);
      expect(await svc.consume(code)).toBe(false);
      // The others are untouched.
      expect(await svc.consume(codes[4]!.reveal())).toBe(true);
      expect(svc.remaining()).toBe(8);
    });

    it('accepts every issued code, once each, in any order', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const svc = service();
      const codes = (await svc.regenerate()).map((c) => c.reveal()).reverse();

      for (const [index, code] of codes.entries()) {
        expect(await svc.consume(code), code).toBe(true);
        expect(svc.remaining()).toBe(RECOVERY_CODE_COUNT - index - 1);
      }
      expect(svc.remaining()).toBe(0);
      // And nothing works once they are all spent.
      expect(await svc.consume(codes[0]!)).toBe(false);
    });

    it('accepts a code typed without its dash, or in lower case', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const svc = service();
      const codes = await svc.regenerate();

      expect(await svc.consume(codes[0]!.reveal().replace('-', ''))).toBe(true);
      expect(await svc.consume(codes[1]!.reveal().toLowerCase())).toBe(true);
    });

    it('rejects a code that was never issued, and empty input', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const svc = service();
      await svc.regenerate();

      expect(await svc.consume('ZZZZZ-ZZZZZ')).toBe(false);
      expect(await svc.consume('')).toBe(false);
      expect(await svc.consume('   ')).toBe(false);
      expect(svc.remaining()).toBe(10);
    });
  });

  describe('regeneration', () => {
    it('invalidates the previous set, used or not', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const svc = service();
      const first = await svc.regenerate();
      await svc.consume(first[0]!.reveal());

      const second = await svc.regenerate();
      expect(svc.remaining()).toBe(10);
      expect(storedCount()).toBe(10);

      // Not one of the old codes survives.
      for (const code of first) {
        expect(await svc.consume(code.reveal()), code.reveal()).toBe(false);
      }
      expect(await svc.consume(second[0]!.reveal())).toBe(true);
    });

    it('clear() removes them all', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const svc = service();
      const codes = await svc.regenerate();

      svc.clear();
      expect(svc.remaining()).toBe(0);
      expect(storedCount()).toBe(0);
      expect(
        getDb().prepare('SELECT COUNT(*) AS c FROM recovery_codes').get(),
      ).toEqual({ c: 0 });
      expect(await svc.consume(codes[0]!.reveal())).toBe(false);
    });
  });
});

function storedCount(): number {
  const row = getDb()
    .prepare('SELECT recovery_codes_count AS c FROM users WHERE id = ?')
    .get(SINGLE_USER_ID) as { c: number };
  return row.c;
}
