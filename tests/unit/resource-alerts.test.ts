import { describe, it, expect } from 'vitest';
import {
  BELOW,
  CLEAR_WINDOW_MS,
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
  opts: { stepMs?: number; from?: RuleState; clearWindowMs?: number } = {},
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
      opts.clearWindowMs ?? CLEAR_WINDOW_MS,
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

  it('clears only at or below the clear threshold, and only after the clear window', () => {
    let state = BELOW;
    const up = evaluateCrossing(state, 0.9, BAND, START, CLEAR_WINDOW_MS);
    expect(up.emit).toBe('alert');
    state = up.next;
    expect(state.since).toBe(new Date(START).toISOString());
    expect(state.clearingSince).toBeNull();

    // Inside the band: still above, no message either way, and no clearing run started —
    // 80 % is above the 75 % clear line.
    const inBand = evaluateCrossing(state, 0.8, BAND, START + 30_000, CLEAR_WINDOW_MS);
    expect(inBand.emit).toBeNull();
    expect(inBand.next.state).toBe('above');
    expect(inBand.next.clearingSince).toBeNull();
    // And `since` is not restamped, so the duration in the recovery is the real one.
    expect(inBand.next.since).toBe(state.since);

    // At the clear line. This *starts* the window; it does not end the alert.
    const dipped = evaluateCrossing(inBand.next, 0.75, BAND, START + 60_000, CLEAR_WINDOW_MS);
    expect(dipped.emit).toBeNull();
    expect(dipped.next.state).toBe('above');
    expect(dipped.next.clearingSince).toBe(new Date(START + 60_000).toISOString());

    // One second short of the window: still nothing, and `clearingSince` is not restamped.
    const nearly = evaluateCrossing(
      dipped.next,
      0.5,
      BAND,
      START + 60_000 + CLEAR_WINDOW_MS - 1_000,
      CLEAR_WINDOW_MS,
    );
    expect(nearly.emit).toBeNull();
    expect(nearly.next.clearingSince).toBe(dipped.next.clearingSince);

    const down = evaluateCrossing(
      nearly.next,
      0.5,
      BAND,
      START + 60_000 + CLEAR_WINDOW_MS,
      CLEAR_WINDOW_MS,
    );
    expect(down.emit).toBe('recovery');
    expect(down.next.state).toBe('below');
    expect(down.next.since).toBeNull();
    expect(down.next.alerted).toBe(false);
    expect(down.next.clearingSince).toBeNull();
    // The record of *when* the operator was told survives the recovery. Nothing branches
    // on it any more — it is the status block's `alertedAt` — and that is stated here so
    // a later change that gates on it fails a test that says why it exists.
    expect(down.next.lastAlertAt).toBe(new Date(START).toISOString());
  });
});

/**
 * The invariant, which is the whole reason this machine was changed in M2.1.
 *
 * **The most recent message the operator received always describes the current state of
 * that rule.** M1.8 debounced the *alert* with a 30-minute cooldown, and that permits a
 * sequence whose last word to the operator is false forever — the four steps below.
 */
describe('the operator is never left holding a message that is no longer true', () => {
  /** The last thing the operator was actually told, or null. */
  function lastMessage(emitted: (string | null)[]): string | null {
    const sent = emitted.filter((e) => e !== null);
    return sent.length === 0 ? null : sent[sent.length - 1]!;
  }

  it('never says "recovered" while the rule is above, however the reading flaps', () => {
    // The sequence M1.8 got wrong, at its own scale: cross, drop, cross back inside the
    // window, then stay above. Under the old machine the drop sent a recovery and the
    // re-cross was swallowed by the cooldown, so the operator's most recent message said
    // "back to normal" about a rule that was above and would stay above indefinitely.
    const window = 30 * 60_000;
    const emitted: (string | null)[] = [];
    let state = BELOW;
    const step = (fraction: number, atMs: number): void => {
      const decision = evaluateCrossing(state, fraction, BAND, atMs, window);
      emitted.push(decision.emit);
      state = decision.next;
    };

    step(0.95, START); //                    t=0    crosses above
    step(0.5, START + 5 * 60_000); //        t=5    drops below the clear line
    step(0.95, START + 10 * 60_000); //      t=10   crosses back above
    for (let m = 11; m <= 120; m += 1) step(0.95, START + m * 60_000); // and stays there

    expect(emitted.filter((e) => e !== null)).toEqual(['alert']);
    expect(lastMessage(emitted)).toBe('alert');
    expect(state.state).toBe('above');
    // The dip is *recorded* as having ended, which is the mechanism: the run reset when
    // the reading came back up, so the thirty minutes never elapsed.
    expect(state.clearingSince).toBeNull();
  });

  it('turns a flap shorter than the clear window into exactly one alert and one recovery', () => {
    const window = 30 * 60_000;
    const emitted: (string | null)[] = [];
    let state = BELOW;
    let atMs = START;
    const step = (fraction: number, advanceMs = 60_000): void => {
      const decision = evaluateCrossing(state, fraction, BAND, atMs, window);
      emitted.push(decision.emit);
      state = decision.next;
      atMs += advanceMs;
    };

    // Ten minutes of flapping either side of both lines, then a sustained clear.
    step(0.95);
    for (let i = 0; i < 5; i += 1) {
      step(0.5);
      step(0.95);
    }
    for (let i = 0; i < 40; i += 1) step(0.5);

    expect(emitted.filter((e) => e !== null)).toEqual(['alert', 'recovery']);
    expect(state.state).toBe('below');
  });

  it('sends the recovery exactly once for a clear that stays clear', () => {
    const window = 30 * 60_000;
    // One minute per sample for two hours: an alert, one recovery when the window
    // elapses, and then nothing at all for the remaining hour and a half.
    const { emitted, state } = run(
      [0.95, ...Array.from({ length: 120 }, () => 0.4)],
      { stepMs: 60_000, clearWindowMs: window },
    );
    expect(emitted).toEqual(['alert', 'recovery']);
    expect(state.state).toBe('below');
    expect(state.clearingSince).toBeNull();
  });

  it('needs no cooldown on the alert side, because a second alert is unreachable', () => {
    // A rule cannot enter `above` twice without leaving it, and it cannot leave without
    // emitting a recovery. So the alert side has no throttle and does not need one — which
    // is the property that lets the clear window do the whole job.
    const window = 30 * 60_000;
    const first = evaluateCrossing(BELOW, 0.95, BAND, START, window);
    expect(first.emit).toBe('alert');

    // The next crossing, one minute later, is not a second alert: it is the same one.
    const again = evaluateCrossing(first.next, 0.96, BAND, START + 60_000, window);
    expect(again.emit).toBeNull();

    // And after a full recovery cycle, a fresh crossing alerts immediately rather than
    // waiting for a cooldown that no longer exists.
    let state = first.next;
    for (let m = 1; m <= 31; m += 1) {
      state = evaluateCrossing(state, 0.4, BAND, START + m * 60_000, window).next;
    }
    expect(state.state).toBe('below');
    const second = evaluateCrossing(state, 0.95, BAND, START + 32 * 60_000, window);
    expect(second.emit).toBe('alert');
  });
});

describe('silence is never ambiguous', () => {
  it('sends a recovery only for an alert the operator was actually told about', () => {
    // `alerted` is no longer set by this function — with the cooldown gone, entering
    // `above` always alerts. What can still fail is the *delivery*: a full queue refuses
    // the newest event, and fifteen failed attempts over 77 minutes end in `abandoned`.
    // In both cases the operator has no record of the alert, so a "back to normal" for it
    // would be a message about nothing.
    //
    // The watchdog writes `alerted: false` when its enqueue is refused
    // (`services/watchdog.service.ts`), and this is the machine honouring that: a rule in
    // `above` whose alert never went out clears in silence.
    const window = 30 * 60_000;
    const undelivered: RuleState = {
      state: 'above',
      since: new Date(START).toISOString(),
      alerted: false,
      lastAlertAt: null,
      clearingSince: new Date(START).toISOString(),
    };

    const cleared = evaluateCrossing(undelivered, 0.4, BAND, START + window, window);
    expect(cleared.emit).toBeNull();
    expect(cleared.next.state).toBe('below');

    // And the same sequence with `alerted: true` does emit, so the assertion above is
    // about the flag and not about the timing.
    const delivered = evaluateCrossing(
      { ...undelivered, alerted: true, lastAlertAt: new Date(START).toISOString() },
      0.4,
      BAND,
      START + window,
      window,
    );
    expect(delivered.emit).toBe('recovery');
  });

  it('reports the transition separately from the message, so the log cannot omit it', () => {
    // The audit row follows `transition` and the Telegram message follows `emit`, and the
    // two disagree in exactly one direction. Collapsing them left the log saying a
    // threshold was crossed and never saying it cleared — which is the log lying by
    // omission, in the same way the state machine could.
    const window = 30 * 60_000;
    const undelivered: RuleState = {
      state: 'above',
      since: new Date(START).toISOString(),
      alerted: false,
      lastAlertAt: null,
      clearingSince: new Date(START).toISOString(),
    };
    const cleared = evaluateCrossing(undelivered, 0.4, BAND, START + window, window);
    expect(cleared.emit).toBeNull();
    expect(cleared.transition).toBe('cleared');

    // And nothing reports a transition that did not happen.
    const steady = evaluateCrossing(BELOW, 0.4, BAND, START, window);
    expect(steady.transition).toBeNull();
    const stillAbove = evaluateCrossing(undelivered, 0.95, BAND, START + 60_000, window);
    expect(stillAbove.transition).toBeNull();

    const crossed = evaluateCrossing(BELOW, 0.95, BAND, START, window);
    expect(crossed.transition).toBe('crossed');
    expect(crossed.emit).toBe('alert');
  });
});

describe('no denominator', () => {
  it('freezes rather than reading as healthy, and keeps the bookkeeping', () => {
    // `memory.max` = the literal `max`, or no cgroup at all. A rule that treated the
    // missing denominator as zero would report a healthy panel; one that reset the state
    // would drop `alerted` and lose the recovery for an alert the operator is holding.
    const alerted = evaluateCrossing(BELOW, 0.95, BAND, START, CLEAR_WINDOW_MS).next;

    const frozen = evaluateCrossing(alerted, null, BAND, START + 30_000, CLEAR_WINDOW_MS);
    expect(frozen.emit).toBeNull();
    expect(frozen.next).toEqual(alerted);

    // The limit comes back and the value is low: the clearing run starts *now* rather
    // than being credited with the time the denominator was missing. Thirty minutes with
    // nothing to divide is not thirty minutes of evidence that the condition ended.
    const back = evaluateCrossing(frozen.next, 0.5, BAND, START + 60_000, CLEAR_WINDOW_MS);
    expect(back.emit).toBeNull();
    expect(back.next.clearingSince).toBe(new Date(START + 60_000).toISOString());

    // And the recovery is still owed, so it arrives a clear window later.
    const recovered = evaluateCrossing(
      back.next,
      0.5,
      BAND,
      START + 60_000 + CLEAR_WINDOW_MS,
      CLEAR_WINDOW_MS,
    );
    expect(recovered.emit).toBe('recovery');
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
