import type { Database } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { generateURI, verifySync } from 'otplib';
import { ScureBase32Plugin } from '@otplib/plugin-base32-scure';
import { getDb } from '../db.js';
import { SecretString, columnAad, decrypt, encrypt } from '../crypto.js';
import { type Clock, isoNow, systemClock } from '../utils/clock.js';
import { SINGLE_USER_ID } from './user.service.js';

/** RFC 6238 defaults, and what every authenticator app assumes. */
export const TOTP_ALGORITHM = 'sha1' as const;
export const TOTP_DIGITS = 6 as const;
export const TOTP_PERIOD_SECONDS = 30;

/**
 * Accepted clock drift, in steps either side of the current one.
 *
 * otplib expresses the window in seconds, so one step is `TOTP_PERIOD_SECONDS`.
 * Symmetric rather than RFC 6238's past-only suggestion, because the thing
 * actually being compensated for here is the *operator's phone* being a few
 * seconds ahead or behind, not network transmission delay.
 */
export const TOTP_DRIFT_STEPS = 1;
export const TOTP_EPOCH_TOLERANCE_SECONDS = TOTP_DRIFT_STEPS * TOTP_PERIOD_SECONDS;

/** 160 bits, RFC 4226 §4 R6's recommendation for HMAC-SHA1. */
export const TOTP_SECRET_BYTES = 20;

export const TOTP_ISSUER = 'cc-panel';

/**
 * The AAD column label. The full AAD is `users:<id>:totp_secret`, so a payload
 * lifted out of this column will not authenticate anywhere else.
 */
export const TOTP_AAD_COLUMN = 'totp_secret';

const base32 = new ScureBase32Plugin();

export interface Enrollment {
  /** The base32 secret. Shown once, for manual entry. */
  secret: SecretString;
  /** `otpauth://totp/...`, for a QR code. Contains the secret. */
  uri: SecretString;
}

/** Why a code was not accepted. Distinguished for the audit log, not for the client. */
export type TotpRejection = 'not-enrolled' | 'bad-code' | 'replayed';

export type TotpResult = { ok: true; step: number } | { ok: false; reason: TotpRejection };

interface TotpStateRow {
  totp_secret_encrypted: string | null;
  totp_enabled: number;
  last_totp_step: number;
}

/**
 * TOTP, mandatory second factor.
 *
 * The secret never exists in the database in plaintext: it is encrypted with the
 * M1.3 module under `users:<id>:totp_secret`, so it is bound to that row and that
 * column and cannot be transplanted.
 *
 * Replay protection is the piece that is easy to leave out and matters most. A
 * six-digit code is valid for a whole step (plus drift), so without it a code
 * observed in transit — over a shoulder, in a screenshot, from a compromised
 * authenticator — can be replayed for up to ninety seconds. The last accepted
 * step is persisted and every new code must come from a strictly greater one, so
 * a code that has been accepted once is dead even inside its own validity window.
 */
export class TotpService {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(opts: { db?: Database; clock?: Clock } = {}) {
    this.#db = opts.db ?? getDb();
    this.#clock = opts.clock ?? systemClock;
  }

  #aad(): string {
    return columnAad('users', SINGLE_USER_ID, TOTP_AAD_COLUMN);
  }

  #state(): TotpStateRow | null {
    const row = this.#db
      .prepare('SELECT totp_secret_encrypted, totp_enabled, last_totp_step FROM users WHERE id = ?')
      .get(SINGLE_USER_ID) as TotpStateRow | undefined;
    return row ?? null;
  }

  isEnabled(): boolean {
    return this.#state()?.totp_enabled === 1;
  }

  /** True once a candidate secret has been stored, whether or not it is confirmed. */
  hasSecret(): boolean {
    const state = this.#state();
    return state !== null && state.totp_secret_encrypted !== null;
  }

  /**
   * Draws a fresh secret, stores it encrypted, and returns it with its
   * `otpauth://` URI.
   *
   * `totp_enabled` is left at 0: an enrolment is not complete until a code
   * generated from the new secret comes back, which is what proves the operator's
   * authenticator actually holds it. Calling this again before confirming
   * overwrites the candidate, which is what a "the QR didn't scan, start over"
   * button needs.
   *
   * `last_totp_step` resets to 0 so the new secret starts with a clean replay
   * window; a step number from the old secret is meaningless against the new one
   * and, if the old step were higher, would reject valid codes.
   *
   * The secret comes from `node:crypto.randomBytes` rather than the library's own
   * generator so the entropy source is explicit and auditable in this file.
   */
  beginEnrollment(username: string): Enrollment {
    const secret = base32.encode(randomBytes(TOTP_SECRET_BYTES), { padding: false });

    this.#db
      .prepare(
        `UPDATE users
            SET totp_secret_encrypted = ?, totp_enabled = 0, last_totp_step = 0, updated_at = ?
          WHERE id = ?`,
      )
      .run(encrypt(secret, this.#aad()), isoNow(this.#clock), SINGLE_USER_ID);

    const uri = generateURI({
      strategy: 'totp',
      issuer: TOTP_ISSUER,
      label: username,
      secret,
      algorithm: TOTP_ALGORITHM,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
    });

    return { secret: new SecretString(secret), uri: new SecretString(uri) };
  }

  /**
   * Checks a code against the stored secret.
   *
   * `enforceEnabled: false` is the enrolment path, where the secret exists but
   * `totp_enabled` is still 0. Everywhere else it must be 1, so a candidate secret
   * that was never confirmed cannot be used to log in.
   *
   * On success the accepted step is persisted before returning, inside the same
   * call, so two requests cannot both accept the same code by racing between the
   * check and the write. The single-flight gate on the authentication endpoints
   * makes that a belt to its braces rather than the only thing holding.
   */
  verify(code: string, opts: { enforceEnabled?: boolean } = {}): TotpResult {
    const enforceEnabled = opts.enforceEnabled ?? true;
    const state = this.#state();

    if (state === null || state.totp_secret_encrypted === null) {
      return { ok: false, reason: 'not-enrolled' };
    }
    if (enforceEnabled && state.totp_enabled !== 1) {
      return { ok: false, reason: 'not-enrolled' };
    }

    const secret = decrypt(state.totp_secret_encrypted, this.#aad());
    const epoch = Math.floor(this.#clock.now() / 1000);

    let result;
    try {
      result = verifySync({
        secret,
        token: code,
        algorithm: TOTP_ALGORITHM,
        digits: TOTP_DIGITS,
        period: TOTP_PERIOD_SECONDS,
        epoch,
        epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS,
        // Exclusive lower bound: a step at or below the last accepted one is
        // rejected. Omitted while it is 0, because otplib validates the bound
        // against the current window and 0 is not a meaningful bound anyway.
        ...(state.last_totp_step > 0 ? { afterTimeStep: state.last_totp_step } : {}),
      });
    } catch {
      // otplib throws for a malformed token (wrong length, non-numeric) and for
      // an out-of-range replay bound. Neither is a match.
      return { ok: false, reason: 'bad-code' };
    }

    if (!result.valid) {
      // A code that would have matched but for the replay bound is worth
      // distinguishing in the audit log: it means someone is reusing a code.
      const wouldMatch = this.#matchesIgnoringReplay(secret, code, epoch);
      return { ok: false, reason: wouldMatch ? 'replayed' : 'bad-code' };
    }

    const step = 'timeStep' in result ? result.timeStep : 0;
    this.#db
      .prepare('UPDATE users SET last_totp_step = ?, updated_at = ? WHERE id = ?')
      .run(step, isoNow(this.#clock), SINGLE_USER_ID);

    return { ok: true, step };
  }

  /** Same check without the replay bound, purely to classify a rejection. */
  #matchesIgnoringReplay(secret: string, code: string, epoch: number): boolean {
    try {
      return verifySync({
        secret,
        token: code,
        algorithm: TOTP_ALGORITHM,
        digits: TOTP_DIGITS,
        period: TOTP_PERIOD_SECONDS,
        epoch,
        epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS,
      }).valid;
    } catch {
      return false;
    }
  }

  /** Confirms an enrolment. Returns false if the code did not verify. */
  completeEnrollment(code: string): TotpResult {
    const result = this.verify(code, { enforceEnabled: false });
    if (!result.ok) return result;

    this.#db
      .prepare('UPDATE users SET totp_enabled = 1, updated_at = ? WHERE id = ?')
      .run(isoNow(this.#clock), SINGLE_USER_ID);

    return result;
  }

  /** Clears the secret and the enabled flag. Recovery codes are the caller's problem. */
  disable(): void {
    this.#db
      .prepare(
        `UPDATE users
            SET totp_secret_encrypted = NULL, totp_enabled = 0, last_totp_step = 0, updated_at = ?
          WHERE id = ?`,
      )
      .run(isoNow(this.#clock), SINGLE_USER_ID);
  }

  /** The last accepted step. Exposed for tests and for the replay assertions. */
  lastAcceptedStep(): number {
    return this.#state()?.last_totp_step ?? 0;
  }
}
