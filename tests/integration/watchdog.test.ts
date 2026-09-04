import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../../src/server/db.js';
import { markerPath, type RunMarker } from '../../src/server/services/watchdog.service.js';
import { createTestServer, type TestContext } from '../helpers/test-server.js';
import { FakeClock } from '../helpers/fake-clock.js';

/**
 * The watchdog as `buildServer` wires it, rather than as a class in isolation.
 *
 * Three things only the wiring can be wrong about, and each is a way the feature could
 * exist and do nothing: the marker landing in a directory the container's ownership pass
 * does not prepare, `onClose` not clearing it so every restart reports itself as
 * unclean, and the two consumers of `resources.service.ts` being handed one another's
 * state by `buildServer` even though the classes keep theirs private.
 */

const GIB = 1024 * 1024 * 1024;

let ctx: TestContext | null = null;
let fixtures: string | null = null;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = null;
  if (fixtures !== null) rmSync(fixtures, { recursive: true, force: true });
  fixtures = null;
});

/** A fixture cgroup: a 1 GiB container at `usedBytes`, two cores. */
function cgroupAt(usedBytes: number, usageUsec = 0): string {
  fixtures = mkdtempSync(join(tmpdir(), 'panel-wd-int-'));
  const files: Record<string, string> = {
    'cgroup.controllers': 'cpuset cpu io memory pids\n',
    'memory.current': `${usedBytes}\n`,
    'memory.max': `${GIB}\n`,
    'cpu.max': '200000 100000\n',
    'cpu.stat': `usage_usec ${usageUsec}\n`,
    'memory.events': 'low 0\nhigh 0\noom 0\noom_kill 0\n',
  };
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(fixtures, name), contents);
  return fixtures;
}

function queuedKinds(): string[] {
  return (getDb().prepare('SELECT kind FROM notification_queue ORDER BY id').all() as { kind: string }[]).map(
    (r) => r.kind,
  );
}

describe('the run marker, through a real boot', () => {
  it('lands in the layout directory the entrypoint prepares, and is removed on close', async () => {
    ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
    // `/data/run/panel.run` — not `config/`, because a marker is not configuration, and
    // the directory is in `ensureDataLayout()` and in the entrypoint's LAYOUT_DIRS so it
    // is not a root-owned directory on a live volume.
    expect(existsSync(markerPath(ctx.dataDir))).toBe(true);
    expect(markerPath(ctx.dataDir)).toBe(join(ctx.dataDir, 'run', 'panel.run'));

    const dataDir = ctx.dataDir;
    await ctx.cleanup();
    ctx = null;
    // `app.close()` is the panel's own definition of a deliberate shutdown, and both the
    // SIGTERM and SIGINT handlers go through it. If this were ever not cleared, every
    // restart would report itself as unclean and the alert would be muted within a day.
    expect(existsSync(markerPath(dataDir))).toBe(false);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports the previous run when a kill left the marker behind', async () => {
    const first = await createTestServer({ PANEL_BASE_PATH: 'x' }, { keepDataDir: true });
    const dataDir = first.dataDir;

    // What a SIGKILL would have left: the marker exactly as the running panel had it.
    // Captured while the server is up, put back after the clean close, because a test
    // cannot actually be killed mid-run.
    const asKilled = JSON.parse(readFileSync(markerPath(dataDir), 'utf-8')) as RunMarker;
    await first.cleanup();
    writeFileSync(markerPath(dataDir), JSON.stringify(asKilled));

    ctx = await createTestServer({ PANEL_BASE_PATH: 'x' }, { dataDir });
    expect(queuedKinds()).toContain('unclean_restart');

    const audited = (
      getDb().prepare('SELECT event FROM audit_log ORDER BY id').all() as { event: string }[]
    ).map((r) => r.event);
    expect(audited).toContain('panel.unclean_restart');
    // And a fresh marker is in place, so this boot is the one being watched.
    expect(existsSync(markerPath(dataDir))).toBe(true);
  });

  it('does nothing at all when the watchdog is switched off', async () => {
    ctx = await createTestServer({ PANEL_BASE_PATH: 'x', PANEL_WATCHDOG_ENABLED: false });
    // No marker, so the off switch is not a half-measure that still reports restarts, and
    // a development box does not accumulate alerts for a transport nobody configured.
    expect(existsSync(markerPath(ctx.dataDir))).toBe(false);
    expect(ctx.app.watchdog.running).toBe(false);
    expect(queuedKinds()).toEqual([]);
  });
});

describe('the two consumers, as buildServer wires them', () => {
  it('gives the endpoint and the watcher separate sample slots', async () => {
    const cgroupRoot = cgroupAt(Math.round(0.5 * GIB));
    const clock = new FakeClock();
    ctx = await createTestServer(
      { PANEL_BASE_PATH: 'x' },
      {
        clock,
        // The same fixture through both seams, which is what makes the assertion
        // non-vacuous: they read identical files and must still disagree about the
        // interval, because each measured its own.
        metrics: { cgroupRoot, startTimer: () => ({ stop: () => {} }) },
        watchdog: { cgroupRoot, startTimer: () => ({ stop: () => {} }) },
      },
    );

    const { metrics, watchdog } = ctx.app;
    expect(metrics).not.toBe(watchdog);

    // Both take a first reading at t = 0. A rate needs two samples, so neither has a
    // percentage yet — which is reported as `null` and never as a fabricated zero.
    metrics.snapshot();
    watchdog.tick();
    expect(metrics.peek()!.cpu.percentOfQuota).toBeNull();
    expect(watchdog.status().cpuPercentOfQuota).toBeNull();

    // One second later, one second of CPU used. Two cores of quota, so the sampler's
    // answer is 50 % over a 1000 ms window.
    clock.advance(1000);
    writeFileSync(join(cgroupRoot, 'cpu.stat'), 'usage_usec 1000000\n');
    metrics.sample();
    expect(metrics.peek()!.cpu.sampleWindowMs).toBe(1000);
    expect(metrics.peek()!.cpu.percentOfQuota).toBe(50);

    // Twenty-nine seconds after that, twelve more seconds of CPU. The watchdog's previous
    // sample is still the one from t = 0, so its window is the whole thirty seconds and
    // its answer is 13 s over 30 s × 2 cores.
    clock.advance(29_000);
    writeFileSync(join(cgroupRoot, 'cpu.stat'), 'usage_usec 13000000\n');
    watchdog.tick();
    expect(watchdog.status().cpuSampleWindowMs).toBe(30_000);
    expect(watchdog.status().cpuPercentOfQuota).toBeCloseTo(21.67, 1);

    // Had `buildServer` handed them one previous-sample slot, the watchdog would have
    // divided a 13-second delta by the sampler's one-second window and reported 650 % —
    // or, with the rounding the other way, 21.67 % would have appeared on the endpoint.
    // Both figures are still numbers, still in range on a dashboard, and wrong by the
    // ratio of the two cadences.
    expect(metrics.peek()!.cpu.percentOfQuota).toBe(50);
  });

  it('does not arm a real timer under vitest unless a test asks', async () => {
    // The suite builds hundreds of servers. A 30 s interval in each of them would be a
    // background job ticking against a database the test is about to delete.
    ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
    expect(ctx.app.watchdog.running).toBe(false);
    // The boot check still ran, which is the half that costs one read and one write.
    expect(existsSync(markerPath(ctx.dataDir))).toBe(true);
    await ctx.cleanup();

    ctx = await createTestServer(
      { PANEL_BASE_PATH: 'x' },
      { watchdog: { autoStart: true, startTimer: () => ({ stop: () => {} }) } },
    );
    expect(ctx.app.watchdog.running).toBe(true);
  });
});
