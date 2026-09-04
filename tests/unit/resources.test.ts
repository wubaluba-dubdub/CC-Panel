import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../helpers/fake-clock.js';
import {
  ResourceSampler,
  cgroupV2Present,
  parseCpuMax,
  parseCpuStat,
  parseMemoryMax,
  parseWholeNumber,
  readCgroup,
  readDisk,
  type StartTimer,
} from '../../src/server/services/resources.service.js';

/**
 * Fixtures, not the live filesystem.
 *
 * Every interesting case here is one this machine cannot produce on demand: a
 * `memory.max` of `max`, a CPU quota of two cores, a truncated `cpu.stat`, a cgroup v1
 * layout. Reading `/sys/fs/cgroup` in a test would assert whatever the machine running
 * it happens to be — which on a developer's box is "no memory.max at the root" and in
 * CI is something else again.
 */
let root: string;
let dataDir: string;

function cgroup(files: Record<string, string>): string {
  const dir = mkdtempSync(join(root, 'cg-'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

/** A limited container: 1 GiB of memory, two cores, some CPU already used. */
function limitedCgroup(usageUsec = 1_000_000): string {
  return cgroup({
    'cgroup.controllers': 'cpuset cpu io memory pids\n',
    'memory.current': '536870912\n',
    'memory.max': '1073741824\n',
    'cpu.max': '200000 100000\n',
    'cpu.stat': `usage_usec ${usageUsec}\nuser_usec 1\nsystem_usec 2\n`,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'panel-cgroup-'));
  dataDir = mkdtempSync(join(tmpdir(), 'panel-metrics-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('cgroup v2 parsers', () => {
  it('reads a whole number and refuses anything else', () => {
    expect(parseWholeNumber('536870912\n')).toBe(536870912);
    expect(parseWholeNumber('0')).toBe(0);
    // The failures that matter: a truncated read, a value with a unit, an empty file.
    // `Number('')` is 0 and `parseInt('12abc')` is 12 — both would be plausible.
    for (const bad of ['', '\n', '12abc', '1 2', '12.5', '-1', 'max', ' ']) {
      expect(parseWholeNumber(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseWholeNumber(null)).toBeNull();
  });

  it('treats memory.max = "max" as unlimited, not as NaN and not as zero', () => {
    expect(parseMemoryMax('max\n')).toEqual({ kind: 'unlimited' });
    expect(parseMemoryMax('1073741824\n')).toEqual({ kind: 'bytes', bytes: 1073741824 });
    expect(parseMemoryMax(null)).toEqual({ kind: 'unavailable', why: 'absent' });
    expect(parseMemoryMax('maximum')).toEqual({ kind: 'unavailable', why: 'unparseable' });
  });

  it('turns cpu.max into cores, and "max" into no ceiling at all', () => {
    expect(parseCpuMax('200000 100000\n')).toEqual({ kind: 'cores', cores: 2 });
    expect(parseCpuMax('50000 100000\n')).toEqual({ kind: 'cores', cores: 0.5 });
    expect(parseCpuMax('max 100000\n')).toEqual({ kind: 'unlimited' });
    expect(parseCpuMax(null)).toEqual({ kind: 'unavailable', why: 'absent' });
    // A period of zero would be a division by zero dressed up as a core count.
    expect(parseCpuMax('100000 0')).toEqual({ kind: 'unavailable', why: 'unparseable' });
    expect(parseCpuMax('200000')).toEqual({ kind: 'unavailable', why: 'unparseable' });
    expect(parseCpuMax('garbage garbage')).toEqual({ kind: 'unavailable', why: 'unparseable' });
  });

  it('finds usage_usec among the other cpu.stat lines, and says so when it cannot', () => {
    expect(parseCpuStat('usage_usec 157592000\nuser_usec 88420000\n')).toEqual({
      kind: 'usec',
      usec: 157592000,
    });
    // A file that exists but has no usage_usec is unparseable, not absent: the
    // distinction is between "no cgroup here" and "a cgroup that answered something
    // this code does not understand", and only the second is a bug worth chasing.
    expect(parseCpuStat('nr_periods 0\n')).toEqual({ kind: 'unavailable', why: 'unparseable' });
    expect(parseCpuStat('usage_usec\n')).toEqual({ kind: 'unavailable', why: 'unparseable' });
    expect(parseCpuStat(null)).toEqual({ kind: 'unavailable', why: 'absent' });
  });

  it('detects v2 by cgroup.controllers and does not guess at a v1 layout', () => {
    const v2 = limitedCgroup();
    expect(cgroupV2Present(v2)).toBe(true);

    // cgroup v1: per-controller directories, differently named files, no
    // cgroup.controllers anywhere. Reading `memory.limit_in_bytes` as though it were
    // `memory.max` is how a v1 host gets a number that is about something else.
    const v1 = cgroup({});
    mkdirSync(join(v1, 'memory'));
    writeFileSync(join(v1, 'memory', 'memory.limit_in_bytes'), '1073741824\n');
    writeFileSync(join(v1, 'memory', 'memory.usage_in_bytes'), '536870912\n');
    expect(cgroupV2Present(v1)).toBe(false);
    expect(readCgroup(v1)).toEqual({
      usedBytes: null,
      limit: { kind: 'unavailable', why: 'absent' },
      usage: { kind: 'unavailable', why: 'absent' },
      quota: { kind: 'unavailable', why: 'absent' },
    });
  });

  it('degrades one field at a time on a truncated or garbage file', () => {
    const dir = cgroup({
      'cgroup.controllers': 'cpu memory\n',
      'memory.current': '536870912\n',
      'memory.max': '107374182', // plausible, just truncated — still a number
      'cpu.max': '2000', // truncated: the period is missing
      'cpu.stat': 'usage_us', // truncated mid-key
    });
    const readings = readCgroup(dir);
    expect(readings.usedBytes).toBe(536870912);
    expect(readings.limit).toEqual({ kind: 'bytes', bytes: 107374182 });
    expect(readings.quota).toEqual({ kind: 'unavailable', why: 'unparseable' });
    expect(readings.usage).toEqual({ kind: 'unavailable', why: 'unparseable' });
  });
});

describe('readDisk', () => {
  it('reports the volume and the database separately', () => {
    writeFileSync(join(dataDir, 'panel.db'), 'x'.repeat(4096));
    writeFileSync(join(dataDir, 'panel.db-wal'), 'y'.repeat(1024));

    const disk = readDisk(dataDir);
    expect(disk.path).toBe(dataDir);
    expect(disk.totalBytes).toBeGreaterThan(0);
    expect(disk.usedBytes).toBeGreaterThan(0);
    expect(disk.usedBytes).toBeLessThanOrEqual(disk.totalBytes);
    // bavail, not bfree: the difference is space an unprivileged process cannot have,
    // which is the whole question M2.4's import cap asks.
    expect(disk.availableBytes).toBeLessThanOrEqual(disk.totalBytes - disk.usedBytes);
    expect(disk.databaseBytes).toBe(4096 + 1024);
  });

  it('answers with zeroes rather than throwing for a directory that is not there', () => {
    const disk = readDisk(join(dataDir, 'does-not-exist'));
    expect(disk.totalBytes).toBe(0);
    expect(disk.databaseBytes).toBe(0);
  });
});

/** A timer the test drives: `fire()` is one cadence tick. */
function fakeTimer(): { start: StartTimer; fire: () => void; armed: () => boolean } {
  let tick: (() => void) | null = null;
  return {
    start: (fn) => {
      tick = fn;
      return {
        stop: () => {
          tick = null;
        },
      };
    },
    fire: () => tick?.(),
    armed: () => tick !== null,
  };
}

describe('ResourceSampler', () => {
  it('reports a limit as a number and no limit as null', () => {
    const clock = new FakeClock();
    const limited = new ResourceSampler({ dataDir, clock, cgroupRoot: limitedCgroup() });
    const unlimited = new ResourceSampler({
      dataDir,
      clock,
      cgroupRoot: cgroup({
        'cgroup.controllers': 'cpu memory\n',
        'memory.current': '412000000\n',
        'memory.max': 'max\n',
        'cpu.max': 'max 100000\n',
        'cpu.stat': 'usage_usec 5\n',
      }),
    });

    expect(limited.snapshot().memory).toEqual({
      usedBytes: 536870912,
      limitBytes: 1073741824,
      source: 'cgroup2',
    });

    const snapshot = unlimited.snapshot();
    expect(snapshot.memory.usedBytes).toBe(412000000);
    expect(snapshot.memory.limitBytes).toBeNull();
    // `max` is still a limit *file*, so the process is confined even though the
    // ceiling is not a number — which is a different fact from "not containerised".
    expect(snapshot.meta.containerized).toBe(true);
    expect(snapshot.meta.source).toBe('cgroup2');
    // No quota means a percentage of quota is undefined. The host's cores are reported
    // so the client can still say what the usage is relative to.
    expect(snapshot.cpu.percentOfQuota).toBeNull();
  });

  it('says os and not-containerised when there is no cgroup v2, rather than guessing', () => {
    const clock = new FakeClock();
    const sampler = new ResourceSampler({ dataDir, clock, cgroupRoot: join(root, 'nothing-here') });

    const snapshot = sampler.snapshot();
    expect(snapshot.meta.source).toBe('os');
    expect(snapshot.meta.containerized).toBe(false);
    expect(snapshot.memory.source).toBe('os');
    // The host's figures are what they are; the flag is what stops them being read as
    // the container's. A null limit here means the same thing it always means.
    expect(snapshot.memory.usedBytes).toBeGreaterThan(0);
    expect(snapshot.memory.limitBytes).toBeNull();
  });

  it('needs two samples for a percentage, and reports null until it has them', () => {
    const clock = new FakeClock();
    const timer = fakeTimer();
    let usage = 1_000_000;
    const dir = limitedCgroup(usage);
    const sampler = new ResourceSampler({
      dataDir,
      clock,
      cgroupRoot: dir,
      cadenceMs: 1000,
      startTimer: timer.start,
    });

    const first = sampler.snapshot();
    expect(first.cpu.usageUsec).toBe(1_000_000);
    expect(first.cpu.percentOfQuota).toBeNull();
    expect(first.cpu.sampleWindowMs).toBeNull();
    expect(first.cpu.quotaCores).toBe(2);

    // One second of wall clock, one second of CPU, two cores of allowance: 50 %.
    // The `× cores` term is the one that is easy to omit, and omitting it here would
    // give 100 % — a number that looks like a pinned container and is wrong by exactly
    // the core allowance.
    usage += 1_000_000;
    writeFileSync(join(dir, 'cpu.stat'), `usage_usec ${usage}\n`);
    clock.advance(1000);
    timer.fire();

    const second = sampler.snapshot();
    expect(second.cpu.percentOfQuota).toBe(50);
    expect(second.cpu.sampleWindowMs).toBe(1000);
  });

  it('serves the cached snapshot between ticks, so a second tab is free', () => {
    const clock = new FakeClock();
    const timer = fakeTimer();
    const sampler = new ResourceSampler({
      dataDir,
      clock,
      cgroupRoot: limitedCgroup(),
      startTimer: timer.start,
    });

    const a = sampler.snapshot();
    clock.advance(250);
    const b = sampler.snapshot();
    expect(b).toBe(a);
    expect(b.meta.sampledAt).toBe(a.meta.sampledAt);
    expect(sampler.samples).toBe(1);
  });

  it('arms on the first request and disarms itself after the idle period', () => {
    const clock = new FakeClock();
    const timer = fakeTimer();
    const sampler = new ResourceSampler({
      dataDir,
      clock,
      cgroupRoot: limitedCgroup(),
      cadenceMs: 1000,
      idleMs: 5000,
      startTimer: timer.start,
    });

    expect(timer.armed()).toBe(false);
    sampler.snapshot();
    expect(timer.armed()).toBe(true);
    expect(sampler.running).toBe(true);

    // Still inside the idle window: the tick samples.
    clock.advance(1000);
    timer.fire();
    expect(sampler.samples).toBe(2);

    // Nobody has asked for five seconds. The timer stops itself.
    clock.advance(5000);
    timer.fire();
    expect(sampler.running).toBe(false);
    expect(timer.armed()).toBe(false);

    // And a request after the gap starts clean rather than dividing a CPU delta by an
    // idle period of unknown length.
    const restarted = sampler.snapshot();
    expect(restarted.cpu.percentOfQuota).toBeNull();
    expect(sampler.running).toBe(true);
  });

  it('reports no percentage when the counter goes backwards or the clock does not move', () => {
    const clock = new FakeClock();
    const timer = fakeTimer();
    const dir = limitedCgroup(5_000_000);
    const sampler = new ResourceSampler({
      dataDir,
      clock,
      cgroupRoot: dir,
      startTimer: timer.start,
    });

    sampler.snapshot();
    // A restarted cgroup resets the counter. A negative delta is not a percentage.
    writeFileSync(join(dir, 'cpu.stat'), 'usage_usec 10\n');
    clock.advance(1000);
    timer.fire();
    expect(sampler.peek()!.cpu.percentOfQuota).toBeNull();

    // And a second sample in the same millisecond divides by zero.
    writeFileSync(join(dir, 'cpu.stat'), 'usage_usec 2000\n');
    timer.fire();
    expect(sampler.peek()!.cpu.percentOfQuota).toBeNull();
  });
});
