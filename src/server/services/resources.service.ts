import { readFileSync, statSync, statfsSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import type { MetricsResponse } from '../../shared/types.js';
import { type Clock, isoFrom, systemClock } from '../utils/clock.js';

/**
 * Resource figures for the panel itself: memory, CPU and the volume.
 *
 * **The reason this file is not four calls to `os`**: `os.totalmem()` and
 * `os.freemem()` report the *host's* memory, not the container's limit. On Railway a
 * service with a 1 GB limit would report the figures of whatever machine the container
 * landed on — tens of gigabytes, mostly free — and the display would say "everything is
 * fine" for the entire approach to an OOM kill. The numbers are not approximate; they
 * are about a different thing. So the figures come from **cgroup v2**, which is what
 * the limit is actually enforced by, and the `os` path is a labelled fallback rather
 * than a silent substitution.
 *
 * Every read here is a `readFileSync` of a file a few bytes long, or one `statfs`.
 * Nothing in this module throws: a file that is missing, truncated or full of
 * something unexpected degrades **one named outcome**, never the endpoint. That is the
 * whole point of the `…Reading` unions below — the caller cannot accidentally treat
 * "there is no limit" as "the limit is zero", because they are different shapes.
 */

// ─── Where the figures come from ─────────────────────────────────────────────

/** The cgroup v2 mount, as seen from inside the container's cgroup namespace. */
export const CGROUP_V2_ROOT = '/sys/fs/cgroup';

/**
 * Which of the two sources produced a snapshot.
 *
 * Chosen **once per snapshot, for all three gauges together**, from whether
 * `memory.current` is readable. A snapshot that took memory from the host and CPU from
 * a cgroup would be half one thing and half another, and nothing downstream could
 * describe it honestly — so if the cgroup cannot answer for memory, the `os` figures
 * are used throughout and the payload says so.
 */
export type MetricsSource = 'cgroup2' | 'os';

/** Why a cgroup figure is not available. Never conflated with a legitimate value. */
export type Unavailable = 'absent' | 'unparseable';

/**
 * A memory limit.
 *
 * `unlimited` is `memory.max` holding the literal string `max`, which is what an
 * unconstrained cgroup writes. Parsing that with `Number()` gives `NaN`, and
 * `used / NaN` formats as `NaN%` if you are lucky and `0%` if some helper coerces it —
 * so it is a *kind*, not a number, and the response carries `limitBytes: null`.
 */
export type LimitReading =
  | { kind: 'bytes'; bytes: number }
  | { kind: 'unlimited' }
  | { kind: 'unavailable'; why: Unavailable };

/**
 * A CPU allowance, in cores.
 *
 * `cpu.max` is `"<quota> <period>"` or `"max <period>"`. `unlimited` means there is no
 * ceiling, so a *percentage of quota* is undefined — the response reports the usage
 * delta and a null percentage rather than inventing a denominator.
 */
export type QuotaReading =
  | { kind: 'cores'; cores: number }
  | { kind: 'unlimited' }
  | { kind: 'unavailable'; why: Unavailable };

/** Cumulative CPU time. Useless from one sample; see {@link ResourceSampler}. */
export type UsageReading =
  | { kind: 'usec'; usec: number }
  | { kind: 'unavailable'; why: Unavailable };

/**
 * The cgroup's cumulative count of processes killed by the OOM killer.
 *
 * Cumulative, so like {@link UsageReading} one reading says nothing; the *increase*
 * is the event. `unavailable` is a third state and not zero, because "this kernel
 * does not expose the counter" and "nothing has been killed" call for opposite
 * conclusions and only one of them is good news.
 */
export type OomReading =
  | { kind: 'count'; kills: number }
  | { kind: 'unavailable'; why: Unavailable };

// ─── Primitive parsers, all total functions ──────────────────────────────────

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * A whole non-negative integer on a line of its own, and nothing else.
 *
 * Deliberately stricter than `Number()`: `Number(' 12\n')` is 12, but so is
 * `Number('')` → 0, and `parseInt('12abc')` → 12. A truncated or garbage file must
 * read as unparseable rather than as a plausible small number.
 */
export function parseWholeNumber(text: string | null): number | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** `/sys/fs/cgroup/memory.max`: a byte count, or the literal `max`. */
export function parseMemoryMax(text: string | null): LimitReading {
  if (text === null) return { kind: 'unavailable', why: 'absent' };
  const trimmed = text.trim();
  if (trimmed === 'max') return { kind: 'unlimited' };
  const bytes = parseWholeNumber(trimmed);
  return bytes === null ? { kind: 'unavailable', why: 'unparseable' } : { kind: 'bytes', bytes };
}

/**
 * `/sys/fs/cgroup/cpu.max`: `"<quota> <period>"` in microseconds, or `"max <period>"`.
 *
 * The cores figure is `quota / period`, and it is the term that is easy to omit: a
 * process fully using one core inside a two-core allowance is at 50 %, not 100 %.
 */
export function parseCpuMax(text: string | null): QuotaReading {
  if (text === null) return { kind: 'unavailable', why: 'absent' };
  const parts = text.trim().split(/\s+/);
  const [quotaRaw, periodRaw] = parts;
  if (quotaRaw === undefined || periodRaw === undefined) {
    return { kind: 'unavailable', why: 'unparseable' };
  }
  if (quotaRaw === 'max') return { kind: 'unlimited' };

  const quota = parseWholeNumber(quotaRaw);
  const period = parseWholeNumber(periodRaw);
  if (quota === null || period === null || period === 0) {
    return { kind: 'unavailable', why: 'unparseable' };
  }
  return { kind: 'cores', cores: quota / period };
}

/** `/sys/fs/cgroup/cpu.stat`, of which only `usage_usec` is used. */
export function parseCpuStat(text: string | null): UsageReading {
  if (text === null) return { kind: 'unavailable', why: 'absent' };
  for (const line of text.split('\n')) {
    const match = /^usage_usec\s+(\d+)$/.exec(line.trim());
    if (match !== null) {
      const usec = parseWholeNumber(match[1]!);
      if (usec !== null) return { kind: 'usec', usec };
      return { kind: 'unavailable', why: 'unparseable' };
    }
  }
  return { kind: 'unavailable', why: 'unparseable' };
}

/**
 * `/sys/fs/cgroup/memory.events`, of which only `oom_kill` is used.
 *
 * The kernel's own key names, so the panel and `cat` agree about what is being
 * counted. `oom_kill` is the number of **processes** killed, not the number of
 * events, so several agents dying in one reclaim failure moves it by more than one —
 * which is worth reporting and is why the delta is carried into the message.
 *
 * Deliberately not `oom`: that counts the times usage was *about* to exceed the
 * limit, which reclaim usually resolves, and alerting on it would report the panel
 * working as designed.
 */
export function parseOomKills(text: string | null): OomReading {
  if (text === null) return { kind: 'unavailable', why: 'absent' };
  for (const line of text.split('\n')) {
    const match = /^oom_kill\s+(\d+)$/.exec(line.trim());
    if (match !== null) {
      const kills = parseWholeNumber(match[1]!);
      if (kills !== null) return { kind: 'count', kills };
      return { kind: 'unavailable', why: 'unparseable' };
    }
  }
  return { kind: 'unavailable', why: 'unparseable' };
}

// ─── cgroup v2 ───────────────────────────────────────────────────────────────

/**
 * Whether this is a cgroup **v2** hierarchy at all.
 *
 * `cgroup.controllers` exists only on v2, so its presence is the detection and there
 * is nothing to guess at. A v1 layout (`memory/memory.limit_in_bytes`) is deliberately
 * **not** read: v1's files are laid out differently, the panel's only deployment target
 * is v2, and a half-supported second hierarchy is a source of plausible wrong numbers.
 * Absent means the `os` path, labelled as such.
 */
export function cgroupV2Present(root: string = CGROUP_V2_ROOT): boolean {
  return readText(join(root, 'cgroup.controllers')) !== null;
}

export interface CgroupReadings {
  /** `memory.current`. Null when the file is absent or unparseable. */
  usedBytes: number | null;
  limit: LimitReading;
  usage: UsageReading;
  quota: QuotaReading;
}

export function readCgroup(root: string = CGROUP_V2_ROOT): CgroupReadings {
  return {
    usedBytes: parseWholeNumber(readText(join(root, 'memory.current'))),
    limit: parseMemoryMax(readText(join(root, 'memory.max'))),
    usage: parseCpuStat(readText(join(root, 'cpu.stat'))),
    quota: parseCpuMax(readText(join(root, 'cpu.max'))),
  };
}

/**
 * The OOM-kill counter, hierarchical first and local second.
 *
 * `memory.events` counts kills in this cgroup **and its descendants**;
 * `memory.events.local` counts only this cgroup. The hierarchical file is the one
 * that answers the question the watchdog asks — *was anything in this container
 * killed for memory* — because the panel's children are the interesting victims and
 * a future build that gives each agent its own sub-cgroup would put them below this
 * one rather than in it. `.local` is the fallback for a kernel that has one and not
 * the other, never a second reading added to the first.
 *
 * Neither file exists on the **true** root cgroup, which is what a developer's
 * machine outside a container has at `/sys/fs/cgroup`. Inside a container the cgroup
 * namespace makes the container's own (non-root) cgroup appear as the root, so both
 * files are there. That asymmetry is the reason `unavailable` is a named outcome
 * rather than a zero.
 */
export function readOomKills(root: string = CGROUP_V2_ROOT): OomReading {
  const hierarchical = parseOomKills(readText(join(root, 'memory.events')));
  if (hierarchical.kind === 'count') return hierarchical;
  const local = parseOomKills(readText(join(root, 'memory.events.local')));
  return local.kind === 'count' ? local : hierarchical;
}

// ─── The volume ──────────────────────────────────────────────────────────────

export interface DiskReading {
  /** The data directory the figures are for. `/data` in production; never a URL. */
  path: string;
  usedBytes: number;
  totalBytes: number;
  /**
   * Free space **for this user**, which is `bavail`, not `bfree`.
   *
   * The two differ by the filesystem's reserved blocks, and the difference is the
   * whole answer to "can this import be written": `totalBytes - usedBytes` includes
   * space an unprivileged process cannot have. M2.4's import caps read this field.
   */
  availableBytes: number;
  /** `panel.db` plus its `-wal` and `-shm` sidecars. */
  databaseBytes: number;
}

/**
 * `statfs` on the data directory, plus the database's own footprint.
 *
 * Both figures, because "the volume is 80 % full" and "the database is 80 % of the
 * volume" call for completely different actions. A full volume is the failure mode
 * that does not announce itself: SQLite starts returning `SQLITE_FULL`, the audit log
 * stops accepting rows, and a panel that cannot write its own audit log is a panel
 * whose security model has quietly stopped working.
 *
 * `projects/` is deliberately **not** walked here. It is the figure PLAN.md asks for
 * alongside these two, and it is the one that cannot be taken on a one-second cadence:
 * a recursive walk of project checkouts and `node_modules` trees is exactly the
 * "resource display that becomes its own load" this sampler exists to avoid. It lands
 * with projects, on its own slow cadence.
 */
export function readDisk(dataDir: string): DiskReading {
  let usedBytes = 0;
  let totalBytes = 0;
  let availableBytes = 0;
  try {
    const fs = statfsSync(dataDir);
    const block = Number(fs.bsize);
    totalBytes = Number(fs.blocks) * block;
    availableBytes = Number(fs.bavail) * block;
    usedBytes = (Number(fs.blocks) - Number(fs.bfree)) * block;
  } catch {
    // A data directory that cannot be stat'd is a much larger problem than a missing
    // gauge, and boot already refuses to start when it is not writable. Zeroes here,
    // never a throw out of the sampler.
  }

  let databaseBytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      databaseBytes += statSync(join(dataDir, `panel.db${suffix}`)).size;
    } catch {
      // Sidecar absent; nothing to add.
    }
  }

  return { path: dataDir, usedBytes, totalBytes, availableBytes, databaseBytes };
}

// ─── The snapshot the endpoint serves ────────────────────────────────────────

/**
 * What the endpoint serves.
 *
 * Declared as the shared `MetricsResponse` and then re-stated in full below, so the
 * two cannot drift: if a field is added here and not to the contract in
 * `src/shared/types.ts` — the file the Phase 2 client reads — this stops compiling.
 */
export type MetricsSnapshot = MetricsResponse & {
  memory: {
    usedBytes: number;
    /** Null means **no limit**, never "unknown" and never zero. */
    limitBytes: number | null;
    source: MetricsSource;
  };
  cpu: {
    /** Null until two samples exist, or when there is no quota to be a percentage of. */
    percentOfQuota: number | null;
    /** `quota / period` from `cpu.max`, or the host's core count on the `os` path. */
    quotaCores: number | null;
    /** Cumulative. Null only when neither source could produce one. */
    usageUsec: number | null;
    /** The wall-clock window the percentage was computed over. Null with the percentage. */
    sampleWindowMs: number | null;
  };
  disk: DiskReading;
  meta: {
    source: MetricsSource;
    containerized: boolean;
    sampledAt: string;
    /** How often the sampler refreshes this while someone is polling. */
    cadenceMs: number;
  };
  /**
   * Per-project attribution, from Phase 3. Never present before it: there are no
   * projects yet, and the panel does not spawn the processes it would have to walk.
   * Declared here so the field's absence is a documented state rather than a shape
   * the client has to learn later — and so it is clear it will be an **array**, not a
   * map, and an estimate (summing RSS over a process tree double-counts shared pages).
   */
  perProject?: readonly {
    projectId: string;
    memoryBytes: number;
    cpuPercent: number | null;
    approximate: true;
  }[];
};

// ─── The CPU rate, as a pure function ────────────────────────────────────────

/** One reading of the cumulative counter, and when it was taken. */
export interface CpuSample {
  readonly usageUsec: number;
  readonly atMs: number;
}

export interface CpuRate {
  /** Null when there is no previous sample, no quota, or the counter went backwards. */
  readonly percentOfQuota: number | null;
  /** The wall-clock window the percentage was computed over. Null with the percentage. */
  readonly sampleWindowMs: number | null;
}

/**
 * `Δusage_usec / (Δwall_µs × cores) × 100`, and **nothing is remembered here**.
 *
 * A pure function taking `previous` as an argument, which is the mechanism that keeps
 * the two consumers of this module apart. {@link ResourceSampler} (poll-driven, 1000
 * ms, disarmed after a minute of nobody looking) and the watchdog (always on, 30 s)
 * each hold their **own** previous sample and pass it in. There is no module-level
 * slot for either of them to overwrite: two consumers sharing one previous-sample
 * slot would give each other's deltas the wrong interval, and the resulting
 * percentage would be wrong in a way that looks entirely plausible — a number, in
 * range, off by the ratio of the two cadences.
 *
 * The `× cores` term is the one that is easy to omit and it is wrong by exactly the
 * core allowance: a process fully using one core inside a two-core quota is at 50 %,
 * not 100 %. It is arithmetic in one place for the same reason.
 */
export function cpuRate(
  previous: CpuSample | null,
  current: CpuSample,
  quotaCores: number | null,
): CpuRate {
  if (previous === null || quotaCores === null || quotaCores <= 0) {
    return { percentOfQuota: null, sampleWindowMs: null };
  }
  const elapsedMs = current.atMs - previous.atMs;
  const deltaUsec = current.usageUsec - previous.usageUsec;
  // A counter that went backwards means the cgroup was recreated; a window of zero or
  // less means the clock did not move. Neither is a percentage.
  if (elapsedMs <= 0 || deltaUsec < 0) return { percentOfQuota: null, sampleWindowMs: null };
  return {
    sampleWindowMs: elapsedMs,
    percentOfQuota: round2((deltaUsec / (elapsedMs * 1000 * quotaCores)) * 100),
  };
}

/** How often the sampler refreshes while someone is polling. */
export const SAMPLE_CADENCE_MS = 1000;

/**
 * How long after the last request the sampler keeps running.
 *
 * Long enough that a hidden browser tab backing off to a 30-second poll keeps it
 * warm — a sampler that stops between polls would answer `percentOfQuota: null` on
 * every one of them, since a rate needs two samples inside one window.
 */
export const SAMPLER_IDLE_MS = 60_000;

export interface TimerHandle {
  stop(): void;
}

export type StartTimer = (fn: () => void, ms: number) => TimerHandle;

const realTimer: StartTimer = (fn, ms) => {
  const timer = setInterval(fn, ms);
  // So a running sampler can never be the reason the process stays alive.
  timer.unref();
  return { stop: () => clearInterval(timer) };
};

export interface ResourceSamplerOptions {
  dataDir: string;
  clock?: Clock;
  /** Overridden by the tests with a fixture directory. */
  cgroupRoot?: string;
  cadenceMs?: number;
  idleMs?: number;
  /** Test seam: the suite drives ticks by hand rather than waiting for a timer. */
  startTimer?: StartTimer;
}

/**
 * One sampler, shared, running **only while someone is polling**.
 *
 * Two things it is built to avoid, and they pull in opposite directions:
 *
 * - **The request must not pay for the interval.** A percentage is a rate, so it needs
 *   two readings of a cumulative counter and the wall-clock time between them. An
 *   endpoint that took the second sample itself would sleep for the window on every
 *   single poll.
 * - **A timer must not run forever.** On an idle panel with nobody looking, a
 *   one-second interval is a wakeup a second for no reader — on a platform billed by
 *   the second, with App Sleeping switched off.
 *
 * So the first request arms the timer and the timer disarms itself once
 * {@link SAMPLER_IDLE_MS} has passed with no request. Stopping **drops the previous
 * sample**: a CPU delta measured across an idle gap of unknown length is not a
 * percentage of anything, and reporting one would be exactly the plausible-looking
 * wrong number this whole module exists to avoid. The first poll after a cold start
 * therefore answers `percentOfQuota: null`, and every poll after it answers a number.
 */
export class ResourceSampler {
  readonly #clock: Clock;
  readonly #dataDir: string;
  readonly #cgroupRoot: string;
  readonly #cadenceMs: number;
  readonly #idleMs: number;
  readonly #startTimer: StartTimer;

  #timer: TimerHandle | null = null;
  #previous: CpuSample | null = null;
  #latest: MetricsSnapshot | null = null;
  #lastRequestAt = 0;
  #samples = 0;

  constructor(opts: ResourceSamplerOptions) {
    this.#clock = opts.clock ?? systemClock;
    this.#dataDir = opts.dataDir;
    this.#cgroupRoot = opts.cgroupRoot ?? CGROUP_V2_ROOT;
    this.#cadenceMs = opts.cadenceMs ?? SAMPLE_CADENCE_MS;
    this.#idleMs = opts.idleMs ?? SAMPLER_IDLE_MS;
    this.#startTimer = opts.startTimer ?? realTimer;
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  /** Samples taken since the sampler last started. For the tests. */
  get samples(): number {
    return this.#samples;
  }

  /**
   * The current figures, for a request.
   *
   * Marks the sampler as wanted, arms the timer if it is not already running, takes a
   * reading if there is not one yet, and returns the cached snapshot. Two requests
   * inside one cadence window get byte-identical answers, including `sampledAt` —
   * which is what makes a second browser tab free.
   */
  snapshot(): MetricsSnapshot {
    this.#lastRequestAt = this.#clock.now();
    if (this.#timer === null) {
      this.#timer = this.#startTimer(() => this.#onTick(), this.#cadenceMs);
    }
    if (this.#latest === null) this.sample();
    return this.#latest!;
  }

  /** The last reading without asking for one. Null before the first. */
  peek(): MetricsSnapshot | null {
    return this.#latest;
  }

  #onTick(): void {
    if (this.#clock.now() - this.#lastRequestAt >= this.#idleMs) {
      this.stop();
      return;
    }
    this.sample();
  }

  /** Takes one reading. Never throws; a failed read degrades one field. */
  sample(): void {
    try {
      this.#latest = this.#read();
      this.#samples += 1;
    } catch {
      // Belt for the braces: every reader above is already total. If one ever is
      // not, the endpoint keeps serving the previous snapshot rather than 500ing.
    }
  }

  stop(): void {
    this.#timer?.stop();
    this.#timer = null;
    this.#previous = null;
    this.#latest = null;
    this.#samples = 0;
  }

  #read(): MetricsSnapshot {
    const atMs = this.#clock.now();
    const cgroup = cgroupV2Present(this.#cgroupRoot) ? readCgroup(this.#cgroupRoot) : null;

    // One source for the whole snapshot, decided by whether the cgroup can answer for
    // memory — which is the gauge the `os` fallback gets *wrong*, rather than merely
    // differently. `containerized` is a separate fact: a cgroup that carries a
    // `memory.max` at all is a confined process, whether the limit is a number or `max`.
    const fromCgroup = cgroup !== null && cgroup.usedBytes !== null;
    const source: MetricsSource = fromCgroup ? 'cgroup2' : 'os';
    const containerized = fromCgroup && cgroup.limit.kind !== 'unavailable';

    const memory = fromCgroup
      ? {
          usedBytes: cgroup.usedBytes!,
          limitBytes: cgroup.limit.kind === 'bytes' ? cgroup.limit.bytes : null,
          source,
        }
      : { usedBytes: totalmem() - freemem(), limitBytes: null, source };

    const quotaCores = fromCgroup
      ? cgroup.quota.kind === 'cores'
        ? cgroup.quota.cores
        : cgroup.quota.kind === 'unlimited'
          ? hostCores()
          : null
      : hostCores();

    const usageUsec = fromCgroup
      ? cgroup.usage.kind === 'usec'
        ? cgroup.usage.usec
        : null
      : hostBusyUsec();

    // `#previous` is this sampler's own slot, and the arithmetic is the shared pure
    // function above precisely so it cannot become anybody else's.
    const rate =
      usageUsec === null
        ? { percentOfQuota: null, sampleWindowMs: null }
        : cpuRate(this.#previous, { usageUsec, atMs }, quotaCores);
    const { percentOfQuota, sampleWindowMs } = rate;
    if (usageUsec !== null) this.#previous = { usageUsec, atMs };

    return {
      memory,
      cpu: {
        percentOfQuota,
        quotaCores: quotaCores === null ? null : round2(quotaCores),
        usageUsec,
        sampleWindowMs,
      },
      disk: readDisk(this.#dataDir),
      meta: { source, containerized, sampledAt: isoFrom(atMs), cadenceMs: this.#cadenceMs },
    };
  }
}

/** Two decimal places. A rounded number is still a number; a formatted one is a string. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function hostCores(): number | null {
  const count = cpus().length;
  return count > 0 ? count : null;
}

/**
 * The host's cumulative busy CPU time, in microseconds.
 *
 * The `os`-path analogue of `usage_usec`, so the same delta arithmetic serves both
 * sources. `os.cpus()` reports per-core times in milliseconds; everything but `idle`
 * is busy.
 */
function hostBusyUsec(): number | null {
  const cores = cpus();
  if (cores.length === 0) return null;
  let busyMs = 0;
  for (const core of cores) {
    busyMs += core.times.user + core.times.nice + core.times.sys + core.times.irq;
  }
  return busyMs * 1000;
}
