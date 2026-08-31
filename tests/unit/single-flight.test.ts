import { describe, it, expect } from 'vitest';
import { SingleFlight, SingleFlightBusyError } from '../../src/server/utils/single-flight.js';

/** A deferred, so a test can hold a task open and observe what the gate does. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('M1.4 — single-flight gate', () => {
  it('runs one task at a time, in admission order', async () => {
    const gate = new SingleFlight(10);
    const events: string[] = [];

    const tasks = [1, 2, 3, 4, 5].map((n) =>
      gate.run(async () => {
        events.push(`start ${n}`);
        // Two microtask turns, so an overlapping implementation would interleave.
        await Promise.resolve();
        await Promise.resolve();
        events.push(`end ${n}`);
      }),
    );

    await Promise.all(tasks);

    expect(events).toEqual([
      'start 1', 'end 1',
      'start 2', 'end 2',
      'start 3', 'end 3',
      'start 4', 'end 4',
      'start 5', 'end 5',
    ]);
  });

  it('accepts one running plus queueLimit waiting, and rejects the rest with 429', async () => {
    const gate = new SingleFlight(1);
    expect(gate.capacity).toBe(2);

    const held = deferred();
    const running = gate.run(() => held.promise);
    const queued = gate.run(async () => undefined);

    expect(gate.inFlight).toBe(2);
    // The third has nowhere to go.
    await expect(gate.run(async () => undefined)).rejects.toBeInstanceOf(SingleFlightBusyError);

    held.resolve();
    await Promise.all([running, queued]);
    expect(gate.inFlight).toBe(0);

    // Capacity is freed again once the queue drains.
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('carries the 429 status on the rejection', async () => {
    const gate = new SingleFlight(0);
    const held = deferred();
    const running = gate.run(() => held.promise);

    const error = await gate.run(async () => undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SingleFlightBusyError);
    expect((error as SingleFlightBusyError).statusCode).toBe(429);

    held.resolve();
    await running;
  });

  it('a failing task does not wedge the queue', async () => {
    const gate = new SingleFlight(5);

    const failing = gate.run(async () => {
      throw new Error('boom');
    });
    const following = gate.run(async () => 'still works');

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('still works');
    expect(gate.inFlight).toBe(0);
  });

  it('rejects a nonsensical queue limit', () => {
    expect(() => new SingleFlight(-1)).toThrow(/non-negative integer/);
    expect(() => new SingleFlight(1.5)).toThrow(/non-negative integer/);
  });

  it('serialises the delay: N tasks each waiting D cost N*D, not D', async () => {
    // The property the gate exists for, in miniature. Each task "waits" by
    // recording its own start and end on a shared virtual clock; without
    // serialisation every task would start at 0 and the total would be one period.
    const gate = new SingleFlight(10);
    const PERIOD = 500;
    let virtualNow = 0;
    const spans: [number, number][] = [];

    await Promise.all(
      [1, 2, 3, 4].map(() =>
        gate.run(async () => {
          const start = virtualNow;
          await Promise.resolve();
          virtualNow += PERIOD;
          spans.push([start, virtualNow]);
        }),
      ),
    );

    expect(virtualNow).toBe(4 * PERIOD);
    // No two spans overlap.
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1]);
    }
  });
});
