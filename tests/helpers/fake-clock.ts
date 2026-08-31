import type { Clock, Sleep } from '../../src/server/utils/clock.js';

/**
 * A clock the test drives by hand.
 *
 * The delay schedule tops out at thirty seconds and the session deadlines are
 * measured in hours and days. A suite that waited for any of it would be unusable,
 * and a suite that asserted on wall-clock elapsed time would be flaky on a loaded
 * CI box. Driving the clock means the assertions are about the *computed* target,
 * which is the thing the specification actually pins down.
 */
export class FakeClock implements Clock {
  #now: number;

  /** A fixed, period-aligned start: 2026-01-01T00:00:00Z. */
  constructor(startMs = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  set(ms: number): void {
    this.#now = ms;
  }

  /** Seconds since the epoch, which is what TOTP counts in. */
  epochSeconds(): number {
    return Math.floor(this.#now / 1000);
  }
}

export interface RecordedSleep {
  readonly sleep: Sleep;
  /** Every duration handed to the sleep function, in order. */
  readonly calls: number[];
  /** The sum of every duration slept. */
  total(): number;
  reset(): void;
}

/**
 * A sleep that does not sleep: it records the requested duration and advances the
 * fake clock by it, so elapsed time behaves exactly as if it had waited while the
 * suite stays fast.
 *
 * Advancing the clock matters and is not just bookkeeping — `AuthDelayService.pad`
 * measures elapsed time from the clock, so a sleep that left the clock alone would
 * make a second attempt in the same test look as though no time had passed.
 */
export function createRecordedSleep(clock: FakeClock): RecordedSleep {
  const calls: number[] = [];
  return {
    sleep: async (ms: number): Promise<void> => {
      calls.push(ms);
      clock.advance(ms);
      // Yield once, so a queued single-flight attempt actually gets to run and
      // the ordering under the gate is exercised rather than short-circuited.
      await Promise.resolve();
    },
    calls,
    total: () => calls.reduce((sum, ms) => sum + ms, 0),
    reset: () => {
      calls.length = 0;
    },
  };
}
