/**
 * Injectable time and sleep.
 *
 * Everything in the authentication path that reads the clock or waits goes
 * through these, so the test suite can drive a login that would otherwise take
 * thirty seconds of real time and assert against the *computed* target rather
 * than against wall-clock elapsed time. A suite that actually slept would be
 * both slow and flaky.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

/** Resolves after roughly `ms`. */
export type Sleep = (ms: number) => Promise<void>;

export const systemClock: Clock = {
  now: () => Date.now(),
};

export const realSleep: Sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The timestamp format used for every column this project writes.
 *
 * ISO-8601 with an explicit `Z`, which is unambiguous and sorts
 * lexicographically in the same order it sorts chronologically — so SQL string
 * comparison on these columns is a valid time comparison. The migrations' own
 * `datetime('now')` defaults are never exercised, because every insert supplies
 * its timestamps explicitly from the injected clock.
 */
export function isoFrom(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export function isoNow(clock: Clock): string {
  return isoFrom(clock.now());
}

/** Parses a timestamp written by {@link isoFrom}. `NaN` for anything unparseable. */
export function msFromIso(value: string | null): number {
  if (value === null) return Number.NaN;
  return Date.parse(value);
}
