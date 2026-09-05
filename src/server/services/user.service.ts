import type { Database } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { hash as argon2Hash, verify as argon2Verify, argon2id, type Options } from 'argon2';
import { getDb } from '../db.js';
import { type Clock, isoNow, systemClock } from '../utils/clock.js';
import { timingSafeEqualStrings } from '../utils/timing-safe.js';
import { assertStrongPassword } from '../utils/weak-passwords.js';

/** There is exactly one user, and migration 001 pins its id with a CHECK. */
export const SINGLE_USER_ID = 1;

/**
 * argon2id parameters for the account password.
 *
 * 64 MiB / t=3 / p=1, which is the OWASP "second recommended" configuration and
 * costs roughly a quarter of a second on the Railway container size this runs on.
 * `parallelism: 1` because the container has one meaningful core and lanes it
 * cannot run concurrently buy nothing.
 *
 * These are recorded in the encoded hash, so raising them later is a matter of
 * re-hashing on next successful login (argon2's `needsRehash`), not a migration.
 */
export const PASSWORD_ARGON2: Options = {
  type: argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};

/**
 * argon2id parameters for recovery codes.
 *
 * Deliberately lighter than the password parameters, and this is a considered
 * choice rather than an oversight. A recovery code is 50 bits drawn from the
 * CSPRNG, so there is no dictionary to run and no human-chosen string to protect;
 * the memory-hard parameter is buying nothing. What it *would* cost is real: a
 * recovery login verifies against every unused code without short-circuiting, so
 * password parameters would put ten 64 MiB hashes on the critical path of the one
 * flow an operator uses when they are already locked out of their authenticator.
 * 19 MiB / t=2 is the OWASP minimum and keeps that under a third of a second.
 */
export const RECOVERY_CODE_ARGON2: Options = {
  type: argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export interface UserRecord {
  id: number;
  username: string;
  passwordHash: string;
  totpSecretEncrypted: string | null;
  totpEnabled: boolean;
  lastTotpStep: number;
  recoveryCodesCount: number;
  /**
   * The operator's chosen interface language, or null.
   *
   * **Null is not `'en'`.** It means they have never chosen, so the guess from
   * `Accept-Language` is still in force; once they choose, this column is the authority and
   * the header is ignored. Collapsing the two would make "we do not know yet"
   * indistinguishable from "they picked English", and the difference is what decides whether
   * a Persian browser gets a Persian panel on its first visit.
   */
  locale: 'en' | 'fa' | null;
  createdAt: string;
  updatedAt: string;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  totp_secret_encrypted: string | null;
  totp_enabled: number;
  last_totp_step: number;
  recovery_codes_count: number;
  locale: 'en' | 'fa' | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    totpSecretEncrypted: row.totp_secret_encrypted,
    totpEnabled: row.totp_enabled === 1,
    lastTotpStep: row.last_totp_step,
    recoveryCodesCount: row.recovery_codes_count,
    locale: row.locale,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The dummy hash, memoised for the process.
 *
 * A hash of a random string that is discarded immediately, so there is nothing to
 * share and nothing to leak by sharing it; the only thing that matters about it is
 * that verifying against it costs the same as verifying against the real one.
 * Production runs one server per process and would compute it once anyway — the
 * memo is there so a test suite that builds thirty servers does not pay for thirty
 * 64 MiB hashes.
 */
let processDummyHash: string | null = null;

/** Test hook: forget the memoised dummy hash. */
export function resetDummyHashCache(): void {
  processDummyHash = null;
}

export class UserService {
  readonly #db: Database;
  readonly #clock: Clock;

  /**
   * A hash of a random string nobody knows, verified against whenever the
   * submitted username does not match. See {@link verifyCredentials}.
   */
  #dummyHash: string | null = null;

  /**
   * How many times the dummy path has run. Exposed so a test can prove the
   * constant-time branch was actually taken for an unknown username, rather than
   * merely observing that the response looked the same.
   */
  #dummyVerifications = 0;

  constructor(opts: { db?: Database; clock?: Clock } = {}) {
    this.#db = opts.db ?? getDb();
    this.#clock = opts.clock ?? systemClock;
  }

  get dummyVerifications(): number {
    return this.#dummyVerifications;
  }

  /**
   * Computes the dummy hash. Called once at boot, before the server listens, so
   * the first unknown-username login does not pay for it (and is not measurably
   * slower than the ones after it).
   */
  async initDummyHash(): Promise<void> {
    if (this.#dummyHash !== null) return;
    processDummyHash ??= await argon2Hash(randomBytes(32).toString('base64'), PASSWORD_ARGON2);
    this.#dummyHash = processDummyHash;
  }

  find(): UserRecord | null {
    const row = this.#db.prepare('SELECT * FROM users WHERE id = ?').get(SINGLE_USER_ID) as
      | UserRow
      | undefined;
    return row ? toRecord(row) : null;
  }

  exists(): boolean {
    return this.find() !== null;
  }

  /**
   * The stored interface language, or null when the operator has never chosen.
   *
   * Deliberately **not** read by `bootstrap.js`: that route is unauthenticated, and
   * `routes/api.ts` keeps database reads off it on purpose. The stored value reaches the
   * client through `GET /api/auth/me` and is cached in `localStorage`, which is what the
   * next boot's bootstrap applies before first paint — so the only wrong-direction frame
   * anyone ever sees is on a brand-new browser profile whose `Accept-Language` disagrees
   * with the stored choice.
   */
  locale(): 'en' | 'fa' | null {
    return this.find()?.locale ?? null;
  }

  setLocale(locale: 'en' | 'fa'): void {
    this.#db
      .prepare('UPDATE users SET locale = ?, updated_at = ? WHERE id = ?')
      .run(locale, isoNow(this.#clock), SINGLE_USER_ID);
  }

  /**
   * Creates the one user. Throws if one already exists — re-seeding would
   * overwrite a password the operator has since changed.
   */
  async seed(username: string, password: string): Promise<UserRecord> {
    if (this.exists()) throw new Error('refusing to re-seed: a user already exists');
    assertStrongPassword(password);

    const now = isoNow(this.#clock);
    const passwordHash = await argon2Hash(password, PASSWORD_ARGON2);

    this.#db
      .prepare(
        `INSERT INTO users (id, username, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(SINGLE_USER_ID, username, passwordHash, now, now);

    const created = this.find();
    if (created === null) throw new Error('seed did not produce a user');
    return created;
  }

  /**
   * Verifies a username and password pair, returning the user or `null`.
   *
   * A full argon2 verification runs on **every** call, including when the
   * username does not match, against {@link #dummyHash}. Without it, an unknown
   * username returns in microseconds and a known one in a quarter of a second,
   * which is a username oracle you can read over the network with no statistics
   * at all.
   *
   * The username itself is compared with `timingSafeEqual` over equal-length
   * buffers, so it cannot be walked a character at a time either. Its length
   * still leaks, which is unavoidable and does not matter: the username is not
   * the secret.
   */
  async verifyCredentials(username: string, password: string): Promise<UserRecord | null> {
    if (this.#dummyHash === null) {
      throw new Error('initDummyHash() must run before verifyCredentials()');
    }

    const user = this.find();

    if (user === null || !timingSafeEqualStrings(username, user.username)) {
      this.#dummyVerifications += 1;
      // Always false. The point is the elapsed time, not the answer.
      await this.#safeVerify(this.#dummyHash, password);
      return null;
    }

    const ok = await this.#safeVerify(user.passwordHash, password);
    return ok ? user : null;
  }

  /** argon2 throws on a malformed digest; a malformed digest is not a match. */
  async #safeVerify(digest: string, password: string): Promise<boolean> {
    try {
      return await argon2Verify(digest, password);
    } catch {
      return false;
    }
  }

  /** Replaces the stored password hash. Does not touch sessions — the caller rotates. */
  async setPassword(password: string): Promise<void> {
    assertStrongPassword(password);
    const passwordHash = await argon2Hash(password, PASSWORD_ARGON2);
    this.#db
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(passwordHash, isoNow(this.#clock), SINGLE_USER_ID);
  }
}

/**
 * Seeds the one user on first boot, and on every boot after that tells the
 * operator to take the password back out of the environment.
 *
 * The warning is all it does on a subsequent boot: it never re-seeds, never
 * compares the environment password against the stored hash, and never
 * overwrites it. An operator who changes their password in the panel and forgets
 * to update Railway must not find themselves reverted on the next deploy.
 */
export async function seedAdminUser(opts: {
  users: UserService;
  username: string | undefined;
  password: string | undefined;
  warn: (message: string) => void;
  info: (message: string) => void;
}): Promise<void> {
  const { users, username, password, warn, info } = opts;

  if (users.exists()) {
    if (password !== undefined) {
      warn(
        'PANEL_ADMIN_PASSWORD is still set but the user already exists. It is ignored. ' +
          'Remove it from the environment — a plaintext password does not need to outlive ' +
          'first boot, and the panel will not re-seed or overwrite the stored hash.',
      );
    }
    return;
  }

  if (username === undefined || password === undefined) {
    throw new Error(
      'no user exists and PANEL_ADMIN_USERNAME / PANEL_ADMIN_PASSWORD are not both set. ' +
        'Set both for the first boot, then remove PANEL_ADMIN_PASSWORD.',
    );
  }

  // Never log the plaintext, and never log the hash either: the hash is offline
  // attackable and the log is retained.
  await users.seed(username, password);
  info('Seeded the single admin user. Two-factor enrolment is required before login can complete.');
}
