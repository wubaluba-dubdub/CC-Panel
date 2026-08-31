import { describe, it, expect, afterEach } from 'vitest';
import {
  DELAY_FREE_FAILURES,
  FIRST_DELAY_MS,
  MAX_DELAY_MS,
  AuthDelayService,
  delayTargetMs,
  targetForAttempt,
} from '../../src/server/services/auth-delay.service.js';
import { createTestServer, type TestContext } from '../helpers/test-server.js';
import { FakeClock, createRecordedSleep } from '../helpers/fake-clock.js';
import { getDb } from '../../src/server/db.js';

describe('M1.4 — progressive delay', () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  describe('delayTargetMs', () => {
    it('adds nothing for the first three failures', () => {
      expect(DELAY_FREE_FAILURES).toBe(3);
      // Indexed by the failure's own ordinal: failures one, two and three are
      // free. (Ordinal 0 is not a real attempt; it is only reachable through the
      // function, never through targetForAttempt.)
      expect(delayTargetMs(1)).toBe(0);
      expect(delayTargetMs(2)).toBe(0);
      expect(delayTargetMs(3)).toBe(0);
    });

    it('follows the specified schedule from the fourth failure', () => {
      // 500ms, 1s, 2s, 4s, 8s, 16s — then the cap.
      expect(delayTargetMs(4)).toBe(500);
      expect(delayTargetMs(5)).toBe(1_000);
      expect(delayTargetMs(6)).toBe(2_000);
      expect(delayTargetMs(7)).toBe(4_000);
      expect(delayTargetMs(8)).toBe(8_000);
      expect(delayTargetMs(9)).toBe(16_000);
      expect(FIRST_DELAY_MS).toBe(500);
    });

    it('caps at thirty seconds and never exceeds it', () => {
      expect(MAX_DELAY_MS).toBe(30_000);
      // Unclamped, the tenth failure would be 32s.
      expect(delayTargetMs(10)).toBe(30_000);
      for (const failures of [10, 11, 20, 50, 1_000, 1_000_000]) {
        expect(delayTargetMs(failures), `failures=${failures}`).toBe(30_000);
        expect(delayTargetMs(failures)).toBeLessThanOrEqual(MAX_DELAY_MS);
      }
    });

    it('is monotonic', () => {
      let previous = -1;
      for (let failures = 0; failures <= 15; failures += 1) {
        const target = delayTargetMs(failures);
        expect(target).toBeGreaterThanOrEqual(previous);
        previous = target;
      }
    });

    it('prices an arriving attempt as though it were about to fail', () => {
      // Which is what makes a success and a failure indistinguishable: both land
      // on the target the *next* failure would have had.
      expect(targetForAttempt(0)).toBe(delayTargetMs(1));
      expect(targetForAttempt(3)).toBe(500);
      expect(targetForAttempt(4)).toBe(1_000);
      expect(targetForAttempt(9)).toBe(30_000);
      expect(targetForAttempt(100)).toBe(30_000);
    });
  });

  describe('the persisted counter', () => {
    it('counts up, and resets only when told to', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const clock = new FakeClock();
      const delay = new AuthDelayService({ db: getDb(), clock });

      expect(delay.failureCount()).toBe(0);
      expect(delay.recordFailure()).toBe(1);
      expect(delay.recordFailure()).toBe(2);
      expect(delay.failureCount()).toBe(2);
      expect(delay.lastFailureAt()).not.toBeNull();

      delay.reset();
      expect(delay.failureCount()).toBe(0);
      expect(delay.lastFailureAt()).toBeNull();
    });

    it('survives a process restart against the same volume', async () => {
      const first = await createTestServer({ PANEL_BASE_PATH: 'x' }, { keepDataDir: true });
      const dataDir = first.dataDir;
      const clock = new FakeClock();

      const before = new AuthDelayService({ db: getDb(), clock });
      for (let i = 0; i < 5; i += 1) before.recordFailure();
      expect(before.failureCount()).toBe(5);
      expect(before.targetMs()).toBe(2_000);

      // Tear the process's database handle down entirely, then come back to the
      // same volume — which is what a Railway redeploy does.
      await first.cleanup();

      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' }, { dataDir });
      const after = new AuthDelayService({ db: getDb(), clock });
      expect(after.failureCount()).toBe(5);
      expect(after.targetMs()).toBe(2_000);
    });
  });

  describe('padding to a target total time', () => {
    it('sleeps only the remainder, so slow work is absorbed rather than added', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const clock = new FakeClock();
      const recorded = createRecordedSleep(clock);
      const delay = new AuthDelayService({ db: getDb(), clock, sleep: recorded.sleep });

      const startedAt = clock.now();
      // Work that took 300ms, against a 500ms target.
      clock.advance(300);
      const padded = await delay.pad(startedAt, 500);

      expect(padded).toBe(200);
      expect(recorded.calls).toEqual([200]);
      expect(clock.now() - startedAt).toBe(500);
    });

    it('does not sleep at all when the work already exceeded the target', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const clock = new FakeClock();
      const recorded = createRecordedSleep(clock);
      const delay = new AuthDelayService({ db: getDb(), clock, sleep: recorded.sleep });

      const startedAt = clock.now();
      clock.advance(900);
      expect(await delay.pad(startedAt, 500)).toBe(0);
      expect(recorded.calls).toEqual([]);
    });

    it('does not sleep when the target is zero', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const clock = new FakeClock();
      const recorded = createRecordedSleep(clock);
      const delay = new AuthDelayService({ db: getDb(), clock, sleep: recorded.sleep });

      expect(await delay.pad(clock.now(), 0)).toBe(0);
      expect(recorded.calls).toEqual([]);
    });
  });
});
