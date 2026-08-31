import type { Database } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { hash as argon2Hash, verify as argon2Verify } from 'argon2';
import { getDb } from '../db.js';
import { SecretString } from '../crypto.js';
import { type Clock, isoNow, systemClock } from '../utils/clock.js';
import { RECOVERY_CODE_ARGON2, SINGLE_USER_ID } from './user.service.js';

export const RECOVERY_CODE_COUNT = 10;

/**
 * Digits 2–9 plus the alphabet without `I` and `O`.
 *
 * `0`/`O` and `1`/`I` are the transcription errors that cost an operator their
 * only way back in, so neither pair is ever both present. `L` and `U` are kept
 * (unlike Crockford's alphabet) because dropping them would leave 30 symbols, and
 * a non-power-of-two alphabet needs rejection sampling to stay unbiased.
 *
 * Exactly 32 symbols, so a byte masked to five bits selects uniformly.
 */
export const RECOVERY_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/* c8 ignore next 3 -- a guard against editing the alphabet, not a branch to test */
if (RECOVERY_CODE_ALPHABET.length !== 32) {
  throw new Error('RECOVERY_CODE_ALPHABET must hold exactly 32 symbols to select without bias');
}

const GROUPS = 2;
const GROUP_LENGTH = 5;

/** 10 symbols from a 32-symbol alphabet: 50 bits. */
export const RECOVERY_CODE_ENTROPY_BITS = GROUPS * GROUP_LENGTH * 5;

/**
 * Strips the display formatting so `abcde-fghjk`, `ABCDE-FGHJK` and
 * `ABCDEFGHJK` are the same code. The canonical form is what gets hashed.
 */
export function canonicaliseRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

function generateCode(): string {
  const bytes = randomBytes(GROUPS * GROUP_LENGTH);
  const symbols = [...bytes].map((byte) => RECOVERY_CODE_ALPHABET[byte & 31]!);
  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i += 1) {
    groups.push(symbols.slice(i * GROUP_LENGTH, (i + 1) * GROUP_LENGTH).join(''));
  }
  return groups.join('-');
}

interface CodeRow {
  id: number;
  code_hash: string;
}

/**
 * Single-use recovery codes.
 *
 * Ten codes, shown exactly once at generation, stored only as argon2id hashes.
 * See {@link RECOVERY_CODE_ARGON2} in `user.service.ts` for why the parameters are
 * lighter than the password's.
 */
export class RecoveryCodesService {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(opts: { db?: Database; clock?: Clock } = {}) {
    this.#db = opts.db ?? getDb();
    this.#clock = opts.clock ?? systemClock;
  }

  /**
   * Replaces every code with ten new ones and returns the plaintexts.
   *
   * The old codes are deleted, used or not: regenerating is what an operator does
   * after a printout goes missing, and leaving the old set live would defeat the
   * point of asking.
   */
  async regenerate(): Promise<SecretString[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateCode);
    const hashes = await Promise.all(
      codes.map((code) => argon2Hash(canonicaliseRecoveryCode(code), RECOVERY_CODE_ARGON2)),
    );
    const now = isoNow(this.#clock);

    const write = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(SINGLE_USER_ID);
      const insert = this.#db.prepare(
        'INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)',
      );
      for (const codeHash of hashes) insert.run(SINGLE_USER_ID, codeHash, now);
      this.#db
        .prepare('UPDATE users SET recovery_codes_count = ?, updated_at = ? WHERE id = ?')
        .run(RECOVERY_CODE_COUNT, now, SINGLE_USER_ID);
    });
    write();

    return codes.map((code) => new SecretString(code));
  }

  remaining(): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS c FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
      .get(SINGLE_USER_ID) as { c: number };
    return row.c;
  }

  /**
   * Spends a code. `true` exactly once per code, `false` for ever after.
   *
   * Every unused code is verified, without short-circuiting on the match, so the
   * elapsed time does not reveal how far down the list the code sat — and, more
   * practically, so the cost of a wrong code and a right code are the same.
   * Ten verifications at the recovery parameters is under a third of a second.
   *
   * Marking used and decrementing the count happen in one transaction, so a crash
   * between them cannot leave a code that is spent but still counted, or counted
   * but still spendable.
   */
  async consume(input: string): Promise<boolean> {
    const candidate = canonicaliseRecoveryCode(input);
    if (candidate.length === 0) return false;

    const rows = this.#db
      .prepare('SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
      .all(SINGLE_USER_ID) as CodeRow[];

    let matchedId: number | null = null;
    for (const row of rows) {
      let ok = false;
      try {
        ok = await argon2Verify(row.code_hash, candidate);
      } catch {
        ok = false;
      }
      // No break: every code is checked whether or not one has already matched.
      if (ok) matchedId = row.id;
    }

    if (matchedId === null) return false;

    const now = isoNow(this.#clock);
    const spend = this.#db.transaction((id: number) => {
      this.#db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').run(now, id);
      this.#db
        .prepare(
          `UPDATE users
              SET recovery_codes_count = (
                    SELECT COUNT(*) FROM recovery_codes
                     WHERE user_id = users.id AND used_at IS NULL
                  ),
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(now, SINGLE_USER_ID);
    });
    spend(matchedId);

    return true;
  }

  /** Used when two-factor is disabled: the codes are second-factor material too. */
  clear(): void {
    const now = isoNow(this.#clock);
    const wipe = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(SINGLE_USER_ID);
      this.#db
        .prepare('UPDATE users SET recovery_codes_count = 0, updated_at = ? WHERE id = ?')
        .run(now, SINGLE_USER_ID);
    });
    wipe();
  }
}
