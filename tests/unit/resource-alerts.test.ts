import { describe, it, expect } from 'vitest';
import {
  ALERT_COOLDOWN_MS,
  BELOW,
  bandFromPercent,
  clampPercent,
  evaluateCrossing,
  evaluateOomKills,
  HYSTERESIS_POINTS,
  type RuleState,
} from '../../src/server/services/resource-alerts.js';

/**
 * The crossing machine, driven as a table.
 *
 * Everything the milestone had to prove about alerting is a property of this function,
 * and it is a pure function precisely so the proof is a list of inputs rather than a
 * fixture tree plus a fake timer plus a queue. The watchdog's own test covers the
 * plumbing; this covers the decision.
 */

const START = Date.UTC(2026, 0, 1);
const BAND = bandFromPercent(85);

/** Feeds a series of readings through the machine, collecting what it emitted. */
function run(
  fractions: (number | null)[],
  opts: { stepMs?: number; from?: RuleState; cooldownMs?: number } = {},
): { emitted: (string | null)[]; state: RuleState } {
  const step = opts.stepMs ?? 30_000;
  let state = opts.from ?? BELOW;
  const emitted: (string | null)[] = [];
  fractions.forEach((fraction, index) => {
    const decision = evaluateCrossing(
      state,
      fraction,
      BAND,
      START + index * step,
      opts.cooldownMs ?? ALERT_COOLDOWN_MS,
    );
    emitted.push(decision.emit);
    state = decision.next;
  });
  return { emitted: emitted.filter((e) => e !== null), state };
}

describe('the band', () => {
  it('derives the clear threshold rather than letting it be configured', () => {
    // Two configurable numbers are two numbers that can be set the wrong way round, and
    // `clear` above `alert` is not a hysteresis band — it is a machine that alternates on
    // every sample. So one number per rule, and the gap is a constant.
    expect(bandFromPercent(85)).toEqual({ alert: 0.85, clear: 0.75 });
    expect(bandFromPercent(80)).toEqual({ alert: 0.8, clear: 0.7 });
    expect(HYSTERESIS_POINTS).toBe(10);
    expect(bandFromPercent(85).clear).toBeLessThan(bandFromPercent(85).alert);
  });

  it('is bounded in both directions, for opposite reasons', () => {
    // Above 99 % there is no warning left; below 10 % the rule fires on an idle panel and
    // teaches the operator to ignore the channel.
    expect(clampPercent(150)).toBe(99);
    expect(clampPercent(1)).toBe(10);
    expect(clampPercent(0)).toBe(10);
    expect(clampPercent(Number.NaN)).toBe(85);
    expect(clampPercent(85.4)).toBe(85);
    // And a clamped band is still a band.
    expect(bandFromPercent(1).clear).toBeGreaterThanOrEqual(0);
  });
});

describe('one alert per crossing', () => {
  it('sends one message for a sustained condition, not one per sample', () => {
    // The whole point. A volume that has been 95 % full for a week is one message. A rule
    // that fired on the *level* would send one every thirty seconds forever, which is how
    // an alert channel becomes something the operator mutes — including the part of it
    // that says "someone signed in".
    const { emitted, state } = run(Array.from({ length: 20 }, () => 0.95));
    expect(emitted).toEqual(['alert']);
    expect(state.state).toBe('above');
    expect(state.alerted).toBe(true);
  });

  it('does not chatter when a value oscillates around the alert threshold', () => {
    // 86 %, 84 %, 86 %, 84 % … crosses the alert line four times and the *clear* line
    // never. Without the band this is eight messages.
    const { emitted } = run([0.86, 0.84, 0.86, 0.84, 0.86, 0.84, 0.86, 0.84]);
    expect(emitted).toEqual(['alert']);
  });

  it('clears only at or below the clear threshold, and says how long it was above', () => {
    let state = BELOW;
    const up = evaluateCrossing(state, 0.9, BAND, START, ALERT_COOLDOWN_MS);
    expect(up.emit).toBe('alert');
    state = up.next;
    expect(state.since).toBe(new Date(START).toISOString());

    // Inside the band: still above, no message either way.
    const inBand = evaluateCrossing(state, 0.8, BAND, START + 30_000, ALERT_COOLDOWN_MS);
    expect(inBand.emit).toBeNull();
    expect(inBand.next.state).toBe('above');
    // And `since` is not restamped, so the duration in the recovery is the real one.
    expect(inBand.next.since).toBe(state.since);

    const down = evaluateCrossing(inBand.next, 0.75, BAND, START + 60_000, ALERT_COOLDOWN_MS);
    expect(down.emit).toBe('recovery');
    expect(down.next.state).toBe('below');
    expect(down.next.since).toBeNull();
    expect(down.next.alerted).toBe(false);
  });
});

describe('silence is never ambiguous', () => {
  it('sends a recovery for every alert it sent, and for nothing else', () => {
    // The cooldown can swallow an alert. When it does, the operator was never told the
    // resource went high — so a "back to normal" for it would be a message about
    // something they have no record of. `alerted` is what keeps the pair honest.
    const cooldownMs = 30 * 60_000;
    let state = BELOW;

    const first = evaluateCrossing(state, 0.9, BAND, START, cooldownMs);
    expect(first.emit).toBe('alert');
    state = first.next;

    const cleared = evaluateCrossing(state, 0.7, BAND, START + 60_000, cooldownMs);
    expect(cleared.emit).toBe('recovery');
    state = cleared.next;

    // A second crossing five minutes later, inside the cooldown: recorded, not reported.
    const second = evaluateCrossing(state, 0.92, BAND, START + 5 * 60_000, cooldownMs);
    expect(second.emit).toBeNull();
    expect(second.next.state).toBe('above');
    expect(second.next.alerted).toBe(false);
    state = second.next;

    // And its clear is silent too, because there is nothing to recover from.
    const secondClear = evaluateCrossing(state, 0.7, BAND, START + 6 * 60_000, cooldownMs);
    expect(secondClear.emit).toBeNull();

    // Past the cooldown, the next crossing is reported again.
    const third = evaluateCrossing(secondClear.next, 0.92, BAND, START + 40 * 60_000, cooldownMs);
    expect(third.emit).toBe('alert');
  });
});

describe('no denominator', () => {
  it('freezes rather than reading as healthy, and keeps the bookkeeping', () => {
    // `memory.max` = the literal `max`, or no cgroup at all. A rule that treated the
    // missing denominator as zero would report a healthy panel; one that reset the state
    // would drop `alerted` and lose the recovery for an alert the operator is holding.
    const alerted = evaluateCrossing(BELOW, 0.95, BAND, START, ALERT_COOLDOWN_MS).next;

    const frozen = evaluateCrossing(alerted, null, BAND, START + 30_000, ALERT_COOLDOWN_MS);
    expect(frozen.emit).toBeNull();
    expect(frozen.next).toEqual(alerted);

    // The limit comes back and the value is low: the recovery is still owed and is sent.
    const back = evaluateCrossing(frozen.next, 0.5, BAND, START + 60_000, ALERT_COOLDOWN_MS);
    expect(back.emit).toBe('recovery');
  });

  it('never emits anything at all while the denominator is missing', () => {
    const { emitted, state } = run([null, null, null, null]);
    expect(emitted).toEqual([]);
    expect(state).toEqual(BELOW);
  });
});

describe('the OOM counter, which is not a threshold', () => {
  it('adopts the first reading instead of reporting the container\'s whole history', () => {
    // Cumulative for the life of the cgroup. A panel that has just learned to read the
    // counter must not announce every kill that happened before this build existed.
    expect(evaluateOomKills(null, 7)).toEqual({ next: 7, newKills: 0 });
  });

  it('reports the increase, in processes rather than events', () => {
    // `oom_kill` counts processes, so three agents dying in one reclaim failure is 3.
    expect(evaluateOomKills(7, 10)).toEqual({ next: 10, newKills: 3 });
    expect(evaluateOomKills(7, 7)).toEqual({ next: 7, newKills: 0 });
  });

  it('resets the baseline when the counter goes backwards, rather than reporting a negative', () => {
    // A lower reading is a new cgroup — a container restart. The kill that ended the
    // previous life is not in this counter at all; it is the unclean-restart detector's.
    expect(evaluateOomKills(7, 0)).toEqual({ next: 0, newKills: 0 });
  });

  it('freezes on an unreadable counter rather than treating it as zero', () => {
    // "This kernel does not expose it" and "nothing has been killed" call for opposite
    // conclusions, and only one of them is good news.
    expect(evaluateOomKills(7, null)).toEqual({ next: 7, newKills: 0 });
    expect(evaluateOomKills(null, null)).toEqual({ next: null, newKills: 0 });
  });
});
