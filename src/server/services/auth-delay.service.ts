import type { Database } from 'better-sqlite3';
import { getDb } from '../db.js';
import { type Clock, type Sleep, isoNow, realSleep, systemClock } from '../utils/clock.js';

/**
 * Failures that cost nothing extra.
 *
 * argon2id at 64 MiB already takes a quarter of a second, so three typos are
 * already slow enough to be worthless to an attacker and fast enough not to
 * punish the operator for fat-fingering a password.
 */
export const DELAY_FREE_FAILURES = 3;

/** The target for the fourth consecutive failure. Doubles from there. */
export const FIRST_DELAY_MS = 500;

/**
 * Hard cap. Beyond roughly this, proxy and client read timeouts start firing and
 * the operator sees a hung request instead of a slow one — which is worse than a
 * shorter delay, because a timeout does not queue behind the single-flight gate.
 */
export const MAX_DELAY_MS = 30_000;

/**
 * The target *total* response time for an attempt that would be the
 * `consecutiveFailures`-th consecutive failure.
 *
 * Indexed by the failure's own ordinal, which is how the schedule is specified:
 * the first three failures add nothing, and the fourth is the first to be
 * delayed.
 *
 *     n:      1  2  3    4      5     6     7     8      9     10+
 *     target: 0  0  0  500ms   1s    2s    4s    8s    16s    30s (capped)
 */
export function delayTargetMs(consecutiveFailures: number): number {
  const tier = consecutiveFailures - DELAY_FREE_FAILURES;
  if (tier <= 0) return 0;
  // 2 ** big is Infinity, and Math.min pins that to the cap — no overflow branch.
  return Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** (tier - 1));
}

/**
 * The target for an attempt arriving with `failuresSoFar` already on the counter.
 *
 * The attempt is priced as though it were about to fail, whatever it turns out to
 * do. That is the whole mechanism: a failure takes the counter to
 * `failuresSoFar + 1` and is padded to this target; a success resets the counter to
 * zero and is padded to the *same* target. The two are indistinguishable from
 * outside, so a correct password is not the one guess that comes back fast.
 *
 * Pricing it from the post-outcome counter instead would hand exactly that signal
 * away, because a success would price at `delayTargetMs(0)` — zero.
 */
export function targetForAttempt(failuresSoFar: number): number {
  return delayTargetMs(failuresSoFar + 1);
}

interface FailureRow {
  consecutive_failures: number;
  last_failure_at: string | null;
}

/**
 * The consecutive-failure counter and the padding that implements the delay.
 *
 * One counter, for the one account, keyed on nothing. Not on the client IP —
 * the operator's address rotates and an attacker's is free to rotate — and not
 * on the username, because there is only one and keying on it would let an
 * attacker choose whether to be counted. Persisted in SQLite so a restart is not
 * a reset.
 */
export class AuthDelayService {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #sleep: Sleep;

  constructor(opts: { db?: Database; clock?: Clock; sleep?: Sleep } = {}) {
    this.#db = opts.db ?? getDb();
    this.#clock = opts.clock ?? systemClock;
    this.#sleep = opts.sleep ?? realSleep;
  }

  #row(): FailureRow {
    const row = this.#db
      .prepare('SELECT consecutive_failures, last_failure_at FROM auth_failures WHERE id = 1')
      .get() as FailureRow | undefined;
    // Migration 007 seeds the row; a missing one means a hand-edited database.
    return row ?? { consecutive_failures: 0, last_failure_at: null };
  }

  failureCount(): number {
    return this.#row().consecutive_failures;
  }

  lastFailureAt(): string | null {
    return this.#row().last_failure_at;
  }

  /** The target for an attempt arriving now. */
  targetMs(): number {
    return targetForAttempt(this.failureCount());
  }

  /** Increments and returns the new count. */
  recordFailure(): number {
    this.#db
      .prepare(
        `UPDATE auth_failures
            SET consecutive_failures = consecutive_failures + 1,
                last_failure_at = ?
          WHERE id = 1`,
      )
      .run(isoNow(this.#clock));
    return this.failureCount();
  }

  /**
   * Back to zero.
   *
   * Called from exactly one place: a login that has had both the password and the
   * second factor accepted. A correct password followed by a wrong code leaves
   * the counter where it was, so the expensive half of a guess cannot be reused
   * to clear the cheap half's cost.
   */
  reset(): void {
    this.#db
      .prepare('UPDATE auth_failures SET consecutive_failures = 0, last_failure_at = NULL WHERE id = 1')
      .run();
  }

  /**
   * Pads the attempt out to `targetMs` measured from `startedAtMs`.
   *
   * A target total time, not work-plus-sleep: argon2's own timing variance —
   * which differs measurably between the real-hash and dummy-hash paths on a
   * loaded machine — is absorbed into the target instead of being added on top of
   * it, so the response time carries no information about which path ran.
   *
   * When the target is zero there is no padding at all and argon2's own cost is
   * the floor. That is the intent: the first three failures are not punished.
   *
   * @returns the milliseconds actually waited.
   */
  async pad(startedAtMs: number, targetMs: number): Promise<number> {
    if (targetMs <= 0) return 0;
    const remaining = targetMs - (this.#clock.now() - startedAtMs);
    if (remaining <= 0) return 0;
    await this.#sleep(remaining);
    return remaining;
  }
}
