import type { Database } from 'better-sqlite3';
import { getDb } from '../db.js';
import { type Clock, isoFrom, isoNow, systemClock } from '../utils/clock.js';

/**
 * When a resource figure becomes a message, and when it stops being one.
 *
 * Everything that decides is a **pure function** here; everything that reads a file
 * or arms a timer is in `watchdog.service.ts`. The split is not tidiness: the three
 * properties this milestone had to prove — one alert per crossing, hysteresis, a
 * recovery for every alert that was actually sent — are properties of a state
 * transition, and a state transition is testable as a table of inputs only if
 * nothing in it touches the clock, the filesystem or the queue.
 *
 * **Alerts fire on a crossing, not on a level.** A rule holds `below` or `above` and
 * emits only on a transition, so a volume that has been 92 % full for a week produces
 * one message rather than one every thirty seconds forever. That is the difference
 * between an alert channel the operator reads and one they mute.
 */

// ─── Thresholds ──────────────────────────────────────────────────────────────

/**
 * The hysteresis band for one rule, as fractions of the limit.
 *
 * Two numbers rather than one, because a value oscillating around a single threshold
 * alternates between alert and recovery — which is the failure mode that makes a
 * threshold alert worthless. `clear` is strictly below `alert` and the band between
 * them is where nothing happens.
 */
export interface Band {
  /** Fires at or above this fraction. */
  readonly alert: number;
  /** Clears at or below this fraction. */
  readonly clear: number;
}

/**
 * How far below the alert threshold the clear threshold sits.
 *
 * Derived rather than configured, and that is deliberate: an operator who could set
 * both could set `clear` above `alert`, which is not a band but a machine that
 * alternates on every sample. One configurable number per rule, and the gap is a
 * constant — which also makes the shipped defaults exactly the 85/75 and 80/70 the
 * design specified.
 */
export const HYSTERESIS_POINTS = 10;

/**
 * Turns one operator-facing percentage into a band.
 *
 * The subtraction happens in **points and not in fractions**: `0.8 - 0.1` is
 * `0.7000000000000001` in binary floating point, which is harmless for a comparison and
 * ugly everywhere it is displayed or asserted. Points first, one division after.
 */
export function bandFromPercent(percent: number): Band {
  const points = clampPercent(percent);
  return { alert: points / 100, clear: Math.max(0, points - HYSTERESIS_POINTS) / 100 };
}

/**
 * Bounded in both directions, for opposite reasons.
 *
 * Above 99 % there is no useful warning left — the kill happens before the sample.
 * Below 10 % the rule fires on an idle panel and trains the operator to ignore it.
 */
export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 85;
  return Math.min(99, Math.max(10, Math.round(percent)));
}

/**
 * How long the reading must stay at or below the clear threshold before a rule
 * recovers.
 *
 * **This is a debounce on the recovery, not a cooldown on the alert**, and the side it
 * is on is the whole point. M1.8 had it on the alert side, which permits this:
 *
 * ```
 * t=0   crosses above  -> alert sent
 * t=5   drops below    -> recovery sent
 * t=10  crosses above  -> suppressed by the cooldown
 * t=10+ stays above indefinitely
 * ```
 *
 * The operator's most recent message says "recovered" while the condition is bad, and
 * nothing ever corrects it. A duplicate message is a nuisance; that is misinformation,
 * and it is the failure that teaches an operator to distrust the channel completely.
 *
 * The invariant this file now holds instead: **the most recent message the operator
 * received always describes the current state of that rule.** One alert on entering
 * `above`; the rule stays `above` until the reading has been at or below the clear
 * threshold continuously for this window; then one recovery, and only then can a new
 * alert fire. A flap produces exactly one alert and exactly one recovery.
 *
 * Half an hour rather than the security alerts' fifteen minutes, because a resource
 * condition is fixed by a human deleting something or restarting something, and
 * neither is a five-minute job — so half an hour of quiet is evidence the human
 * finished, not evidence of a gap between two spikes.
 */
export const CLEAR_WINDOW_MS = 30 * 60_000;

// ─── The crossing machine ────────────────────────────────────────────────────

export type CrossingState = 'below' | 'above';

export interface RuleState {
  readonly state: CrossingState;
  /** When it entered `above`, so a recovery can say how long it was there. */
  readonly since: string | null;
  /**
   * Whether the operator was actually **told**.
   *
   * Kept from M1.8 even though the alert side no longer has a throttle to swallow an
   * alert, because a *queued* alert is not a delivered one: fifteen failed attempts
   * over 77 minutes end in `abandoned`, and a recovery for an alert the operator never
   * saw is a message about nothing. Every alert that went out gets a recovery; nothing
   * else does.
   */
  readonly alerted: boolean;
  /**
   * When the alert was sent.
   *
   * **Nothing branches on this.** It was the cooldown's clock in M1.8 and it is now a
   * record for the status block — kept because "when was I told" is a useful thing to
   * be able to answer, and named here because a timestamp that used to gate something
   * is exactly the field a later change would gate on again. The gate is
   * {@link RuleState.clearingSince}, on the other side.
   */
  readonly lastAlertAt: string | null;
  /**
   * When the current continuous run at or below the clear threshold began.
   *
   * Null means there is no run in progress: either the rule is `below` already, or it
   * is `above` and the latest reading was still over the clear line. A reading back
   * above the clear line sets this to null, which is the debounce reset.
   */
  readonly clearingSince: string | null;
}

export const BELOW: RuleState = {
  state: 'below',
  since: null,
  alerted: false,
  lastAlertAt: null,
  clearingSince: null,
};

export interface CrossingDecision {
  readonly next: RuleState;
  /**
   * What to **tell the operator**, or null for nothing.
   *
   * Distinct from {@link CrossingDecision.transition} because they can disagree in one
   * direction: a rule leaving `above` whose alert was never delivered transitions and
   * says nothing, because a "back to normal" for a message the operator never got is a
   * message about nothing.
   */
  readonly emit: 'alert' | 'recovery' | null;
  /**
   * What **happened**, or null if nothing did.
   *
   * The audit row follows this and not `emit`. Collapsing the two would leave the log
   * saying a threshold was crossed and never saying it cleared — the log lying by
   * omission, in exactly the way this file exists to prevent.
   */
  readonly transition: 'crossed' | 'cleared' | null;
}

/**
 * One sample against one rule.
 *
 * `fraction === null` means there is no denominator — `memory.max` holding the literal
 * `max`, or no cgroup at all — and the machine **freezes**: no transition, no message,
 * and no bookkeeping lost. A rule that treated a missing denominator as zero would
 * report a healthy panel; one that reset the state would drop the `alerted` flag and
 * lose the recovery for an alert the operator is still holding. It also does **not**
 * advance the clearing run: a rule that lost its denominator mid-run must not be
 * counted as thirty quiet minutes.
 */
export function evaluateCrossing(
  current: RuleState,
  fraction: number | null,
  band: Band,
  nowMs: number,
  clearWindowMs: number = CLEAR_WINDOW_MS,
): CrossingDecision {
  if (fraction === null) return { next: current, emit: null, transition: null };

  if (current.state === 'below') {
    if (fraction < band.alert) {
      // Below and staying below. `clearingSince` has no meaning here; normalise it so
      // a state left over from an earlier version of the row cannot survive.
      return current.clearingSince === null
        ? { next: current, emit: null, transition: null }
        : { next: { ...current, clearingSince: null }, emit: null, transition: null };
    }

    // Entering `above`. **No cooldown on this side, deliberately**: the rule cannot be
    // here unless a recovery was emitted first, so a second alert without an
    // intervening recovery is unreachable rather than suppressed.
    return {
      next: {
        state: 'above',
        since: isoFrom(nowMs),
        alerted: true,
        lastAlertAt: isoFrom(nowMs),
        clearingSince: null,
      },
      emit: 'alert',
      transition: 'crossed',
    };
  }

  // Above. Still above until it is at or below the *clear* line, which is the whole
  // point of the band: one number would make 85.0 % and 84.9 % a message each.
  if (fraction > band.clear) {
    // The debounce reset. A dip that comes back up starts the window again from zero,
    // which is what makes a flap one alert and one recovery instead of a stream.
    return current.clearingSince === null
      ? { next: current, emit: null, transition: null }
      : { next: { ...current, clearingSince: null }, emit: null, transition: null };
  }

  // At or below the clear line. Start the run, or see whether it is long enough.
  if (current.clearingSince === null) {
    return {
      next: { ...current, clearingSince: isoFrom(nowMs) },
      emit: null,
      transition: null,
    };
  }
  if (nowMs - Date.parse(current.clearingSince) < clearWindowMs) {
    return { next: current, emit: null, transition: null };
  }

  return {
    next: {
      state: 'below',
      since: null,
      alerted: false,
      lastAlertAt: current.lastAlertAt,
      clearingSince: null,
    },
    emit: current.alerted ? 'recovery' : null,
    transition: 'cleared',
  };
}

/**
 * The OOM counter, which is not a threshold at all.
 *
 * `previous === null` adopts the reading without reporting it: the counter is
 * cumulative for the life of the cgroup, so a panel that has just learned to read it
 * must not announce every kill that happened before this build existed. A reading
 * *lower* than the stored one is a new cgroup — a container restart — and resets the
 * baseline rather than reporting a negative delta.
 */
export function evaluateOomKills(
  previous: number | null,
  current: number | null,
): { readonly next: number | null; readonly newKills: number } {
  if (current === null) return { next: previous, newKills: 0 };
  if (previous === null || current < previous) return { next: current, newKills: 0 };
  return { next: current, newKills: current - previous };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

/** Which rules the store knows about. Column names are built from these. */
export type RuleName = 'memory' | 'disk';

export interface AlertState {
  readonly memory: RuleState;
  readonly disk: RuleState;
  readonly oomKills: number | null;
}

interface StateRow {
  memory_state: CrossingState;
  memory_since: string | null;
  memory_alerted: number;
  memory_last_alert_at: string | null;
  memory_clearing_since: string | null;
  disk_state: CrossingState;
  disk_since: string | null;
  disk_alerted: number;
  disk_last_alert_at: string | null;
  disk_clearing_since: string | null;
  oom_kills: number | null;
}

/**
 * The crossing state, in `notification_state` beside the drop counter.
 *
 * One row, read once per tick and **written only when something changed**. The read
 * is the cheap half; the write is the one worth guarding, because a watchdog that
 * dirtied a page every thirty seconds for the life of the deployment would be the
 * monitoring becoming its own load — the same objection that keeps a write probe out
 * of `/healthz`.
 */
export class AlertStateStore {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(opts: { db?: Database; clock?: Clock } = {}) {
    this.#db = opts.db ?? getDb();
    this.#clock = opts.clock ?? systemClock;
  }

  read(): AlertState {
    const row = this.#db
      .prepare(
        `SELECT memory_state, memory_since, memory_alerted, memory_last_alert_at,
                memory_clearing_since,
                disk_state, disk_since, disk_alerted, disk_last_alert_at,
                disk_clearing_since, oom_kills
           FROM notification_state WHERE id = 1`,
      )
      .get() as StateRow | undefined;

    if (row === undefined) return { memory: BELOW, disk: BELOW, oomKills: null };
    return {
      memory: {
        state: row.memory_state,
        since: row.memory_since,
        alerted: row.memory_alerted === 1,
        lastAlertAt: row.memory_last_alert_at,
        clearingSince: row.memory_clearing_since,
      },
      disk: {
        state: row.disk_state,
        since: row.disk_since,
        alerted: row.disk_alerted === 1,
        lastAlertAt: row.disk_last_alert_at,
        clearingSince: row.disk_clearing_since,
      },
      oomKills: row.oom_kills,
    };
  }

  /** Writes only what differs. Returns whether anything was written. */
  write(previous: AlertState, next: AlertState): boolean {
    if (!changed(previous, next)) return false;
    this.#db
      .prepare(
        `UPDATE notification_state
            SET memory_state = ?, memory_since = ?, memory_alerted = ?, memory_last_alert_at = ?,
                memory_clearing_since = ?,
                disk_state = ?, disk_since = ?, disk_alerted = ?, disk_last_alert_at = ?,
                disk_clearing_since = ?,
                oom_kills = ?, updated_at = ?
          WHERE id = 1`,
      )
      .run(
        next.memory.state,
        next.memory.since,
        next.memory.alerted ? 1 : 0,
        next.memory.lastAlertAt,
        next.memory.clearingSince,
        next.disk.state,
        next.disk.since,
        next.disk.alerted ? 1 : 0,
        next.disk.lastAlertAt,
        next.disk.clearingSince,
        next.oomKills,
        isoNow(this.#clock),
      );
    return true;
  }
}

function sameRule(a: RuleState, b: RuleState): boolean {
  return (
    a.state === b.state &&
    a.since === b.since &&
    a.alerted === b.alerted &&
    a.lastAlertAt === b.lastAlertAt &&
    a.clearingSince === b.clearingSince
  );
}

function changed(a: AlertState, b: AlertState): boolean {
  return !(sameRule(a.memory, b.memory) && sameRule(a.disk, b.disk) && a.oomKills === b.oomKills);
}
