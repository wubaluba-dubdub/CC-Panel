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
 * How long one alert for a rule silences the next.
 *
 * Hysteresis stops chatter *on the boundary*; this bounds a workload that genuinely
 * swings through the whole band. Half an hour rather than the security alerts'
 * fifteen minutes, because a resource condition is fixed by a human deleting
 * something or restarting something, and neither is a five-minute job.
 */
export const ALERT_COOLDOWN_MS = 30 * 60_000;

// ─── The crossing machine ────────────────────────────────────────────────────

export type CrossingState = 'below' | 'above';

export interface RuleState {
  readonly state: CrossingState;
  /** When it entered `above`, so a recovery can say how long it was there. */
  readonly since: string | null;
  /**
   * Whether the operator was actually **told**.
   *
   * Distinct from `state` because the cooldown can swallow an alert, and a recovery
   * for an alert that was never sent is a message about nothing. Every alert that went
   * out gets a recovery; nothing else does. That is what makes silence unambiguous in
   * both directions.
   */
  readonly alerted: boolean;
  readonly lastAlertAt: string | null;
}

export const BELOW: RuleState = { state: 'below', since: null, alerted: false, lastAlertAt: null };

export interface CrossingDecision {
  readonly next: RuleState;
  readonly emit: 'alert' | 'recovery' | null;
}

/**
 * One sample against one rule.
 *
 * `fraction === null` means there is no denominator — `memory.max` holding the literal
 * `max`, or no cgroup at all — and the machine **freezes**: no transition, no message,
 * and no bookkeeping lost. A rule that treated a missing denominator as zero would
 * report a healthy panel; one that reset the state would drop the `alerted` flag and
 * lose the recovery for an alert the operator is still holding.
 */
export function evaluateCrossing(
  current: RuleState,
  fraction: number | null,
  band: Band,
  nowMs: number,
  cooldownMs: number = ALERT_COOLDOWN_MS,
): CrossingDecision {
  if (fraction === null) return { next: current, emit: null };

  if (current.state === 'below') {
    if (fraction < band.alert) return { next: current, emit: null };

    const cooled =
      current.lastAlertAt === null || nowMs - Date.parse(current.lastAlertAt) >= cooldownMs;
    return {
      next: {
        state: 'above',
        since: isoFrom(nowMs),
        alerted: cooled,
        lastAlertAt: cooled ? isoFrom(nowMs) : current.lastAlertAt,
      },
      emit: cooled ? 'alert' : null,
    };
  }

  // Above. Still above until it is at or below the *clear* line, which is the whole
  // point of the band: one number would make 85.0 % and 84.9 % a message each.
  if (fraction > band.clear) return { next: current, emit: null };

  return {
    next: { state: 'below', since: null, alerted: false, lastAlertAt: current.lastAlertAt },
    emit: current.alerted ? 'recovery' : null,
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
  disk_state: CrossingState;
  disk_since: string | null;
  disk_alerted: number;
  disk_last_alert_at: string | null;
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
                disk_state, disk_since, disk_alerted, disk_last_alert_at, oom_kills
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
      },
      disk: {
        state: row.disk_state,
        since: row.disk_since,
        alerted: row.disk_alerted === 1,
        lastAlertAt: row.disk_last_alert_at,
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
                disk_state = ?, disk_since = ?, disk_alerted = ?, disk_last_alert_at = ?,
                oom_kills = ?, updated_at = ?
          WHERE id = 1`,
      )
      .run(
        next.memory.state,
        next.memory.since,
        next.memory.alerted ? 1 : 0,
        next.memory.lastAlertAt,
        next.disk.state,
        next.disk.since,
        next.disk.alerted ? 1 : 0,
        next.disk.lastAlertAt,
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
    a.lastAlertAt === b.lastAlertAt
  );
}

function changed(a: AlertState, b: AlertState): boolean {
  return !(sameRule(a.memory, b.memory) && sameRule(a.disk, b.disk) && a.oomKills === b.oomKills);
}
