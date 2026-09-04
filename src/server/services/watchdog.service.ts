import type { Database } from 'better-sqlite3';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Clock, isoFrom, systemClock } from '../utils/clock.js';
import { AuditEvent, type AuditService } from './audit.service.js';
import type { NotifyService } from './notify.service.js';
import {
  ALERT_COOLDOWN_MS,
  AlertStateStore,
  type Band,
  bandFromPercent,
  evaluateCrossing,
  evaluateOomKills,
  type RuleState,
} from './resource-alerts.js';
import {
  CGROUP_V2_ROOT,
  type CpuSample,
  cgroupV2Present,
  cpuRate,
  type DiskReading,
  type MetricsSource,
  readCgroup,
  readDisk,
  readOomKills,
  type StartTimer,
  type TimerHandle,
} from './resources.service.js';

/**
 * The always-on watcher, and the only thing in the panel that can see a resource
 * problem while nobody is looking at it.
 *
 * ── Why this is not the metrics sampler ─────────────────────────────────────
 *
 * {@link ResourceSampler} is poll-driven by design: armed by the first
 * `GET /api/metrics`, 1000 ms cadence, disarmed after 60 s with nobody asking. That is
 * right for a widget and structurally useless for an alert — a crossing that happens
 * while nobody is polling is a crossing nothing observes, so an alert machine bolted
 * to it would fire *when the operator opens the panel*, which is the one moment they
 * are already looking.
 *
 * So this is a **second sample pair** at a 30 s cadence, from boot to shutdown.
 *
 * ── How the two are kept apart ──────────────────────────────────────────────
 *
 * They call the same reading functions and share **no mutable state**, and that is
 * structural rather than careful:
 *
 * - every reader in `resources.service.ts` is a pure function of a path — there is no
 *   module-level mutable slot for either consumer to overwrite;
 * - the CPU rate is {@link cpuRate}, which takes `previous` as an **argument** and
 *   remembers nothing. Each consumer holds its own `#previous` and passes it in.
 *
 * The failure this prevents is not a crash. Two consumers sharing one previous-sample
 * slot would each divide their delta by the other's interval, and at 1000 ms against
 * 30 000 ms the answer would be wrong by a factor of thirty — still a number, still in
 * range, still plausible on a dashboard.
 *
 * ── What it can and cannot see ──────────────────────────────────────────────
 *
 * It can see a child process killed by the OOM killer — an agent, a build, a git
 * subprocess — because the panel survives that and the cgroup counter records it. That
 * is the case worth alerting on, and it is exactly the scenario in the concurrency
 * policy: several agents inside one gigabyte.
 *
 * It cannot see the kill that takes the whole container, because the process that
 * would report it is the one that died. {@link Watchdog.bootCheck} is what covers that
 * case, from the other side of the restart.
 *
 * One property worth stating because it is easy to assume the opposite: the queue is a
 * table on the volume and `notify()` is one committed INSERT, so an alert enqueued
 * moments before the process is killed is **delivered after the restart**. SQLite runs
 * here at the default `synchronous=FULL`, so that holds for a power loss as well as
 * for a SIGKILL.
 */

/** The 30 s cadence. Memory and disk do not cross a threshold in a second. */
export const WATCHDOG_CADENCE_MS = 30_000;

/** Directory under the data dir holding the run marker. */
export const RUN_DIR = 'run';

/** The marker file inside it. */
export const RUN_MARKER = 'panel.run';

/**
 * How long one OOM or unclean-restart message silences the next.
 *
 * These two do not go through the crossing machine — there is nothing to cross — so
 * they carry their own throttle key into `notify()`. A container that crash-loops every
 * ten seconds otherwise enqueues one unclean-restart alert per boot until the queue cap
 * starts refusing the security alerts that would tell the operator *why*.
 */
export const EVENT_THROTTLE_MS = 30 * 60_000;

// ─── The run marker ──────────────────────────────────────────────────────────

/**
 * What the previous run left behind.
 *
 * Written at boot, rewritten with a fresh `lastSeenAt` on every tick, and **removed on
 * a graceful shutdown**. So its presence at boot means the previous run was not given
 * the chance to shut down, or did not take it.
 *
 * A file and not a database row, for two reasons that are not style. Its *absence* is
 * the signal, so it has to be readable by a boot that has not opened the database yet —
 * and the crashes most worth detecting are exactly the ones that can involve the
 * database or the volume. And a row rewritten every thirty seconds for the life of the
 * deployment is the monitoring becoming its own load: the same objection that keeps a
 * write probe out of `/healthz`. This is one ~200-byte file instead.
 */
export interface RunMarker {
  readonly startedAt: string;
  readonly pid: number;
  readonly lastSeenAt: string;
  readonly usedBytes: number | null;
  readonly limitBytes: number | null;
  readonly cpuPercentOfQuota: number | null;
  readonly source: MetricsSource;
}

/**
 * What `bootCheck()` found, or null for a clean previous shutdown.
 *
 * `unreadable` is a marker that was there and could not be parsed — a torn write, or a
 * file from a future build. It is still an unclean restart: the file's *presence* is
 * the whole signal and its contents are only the detail.
 */
export interface UncleanRestart {
  readonly previousStartedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly ranForSeconds: number | null;
  readonly usedBytes: number | null;
  readonly limitBytes: number | null;
  readonly unreadable: boolean;
}

export function markerPath(dataDir: string): string {
  return join(dataDir, RUN_DIR, RUN_MARKER);
}

/** Never throws: a marker that cannot be read is reported, not fatal. */
export function readMarker(dataDir: string): { present: boolean; marker: RunMarker | null } {
  let text: string;
  try {
    text = readFileSync(markerPath(dataDir), 'utf-8');
  } catch {
    return { present: false, marker: null };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return { present: true, marker: null };
    const candidate = parsed as Partial<RunMarker>;
    if (typeof candidate.startedAt !== 'string' || typeof candidate.lastSeenAt !== 'string') {
      return { present: true, marker: null };
    }
    return { present: true, marker: candidate as RunMarker };
  } catch {
    return { present: true, marker: null };
  }
}

/**
 * Write-then-rename, so a reader never sees half a marker.
 *
 * Not because a torn read is unrecoverable — it is treated as an unclean restart with
 * no detail, which is the safe reading — but because two lines here turn a case the
 * operator would have to interpret into one that cannot happen.
 */
export function writeMarker(dataDir: string, marker: RunMarker): void {
  const target = markerPath(dataDir);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(join(dataDir, RUN_DIR), { recursive: true });
    writeFileSync(temp, JSON.stringify(marker), { mode: 0o600 });
    renameSync(temp, target);
  } catch {
    // A marker that cannot be written costs the next boot's detection and nothing
    // else. It must never cost the boot itself.
    try {
      rmSync(temp, { force: true });
    } catch {
      /* nothing left to do */
    }
  }
}

export function clearMarker(dataDir: string): void {
  try {
    rmSync(markerPath(dataDir), { force: true });
  } catch {
    /* already gone, or a volume that is no longer writable */
  }
}

// ─── Status, for the tests today and M2.7 later ──────────────────────────────

export interface RuleStatus {
  /** False when there is no denominator, which is a *disabled* rule and not a healthy one. */
  readonly armed: boolean;
  /** Why it is not armed, in machine-readable form. Null when it is. */
  readonly reason: 'no_limit' | 'unavailable' | null;
  readonly thresholdPercent: number;
  readonly clearPercent: number;
  readonly state: RuleState['state'];
  /** The last observed fraction as a percentage, or null. */
  readonly percent: number | null;
}

export interface WatchdogStatus {
  readonly running: boolean;
  readonly cadenceMs: number;
  readonly sampledAt: string | null;
  readonly source: MetricsSource | null;
  readonly memory: RuleStatus;
  readonly disk: RuleStatus;
  readonly oomKills: number | null;
  readonly cpuPercentOfQuota: number | null;
  /**
   * The wall-clock window the CPU figure was computed over.
   *
   * Reported so the two consumers of `resources.service.ts` can be told apart by
   * evidence: this watcher's window is its own cadence and the metrics sampler's is
   * its own, and a shared previous-sample slot would show up here as one of them
   * carrying the other's interval.
   */
  readonly cpuSampleWindowMs: number | null;
}

export interface WatchdogOptions {
  dataDir: string;
  notify: NotifyService;
  audit: AuditService;
  db?: Database;
  clock?: Clock;
  cgroupRoot?: string;
  /** Operator-facing alert thresholds, as whole percentages. */
  memoryPercent?: number;
  diskPercent?: number;
  cadenceMs?: number;
  cooldownMs?: number;
  startTimer?: StartTimer;
  /**
   * Test seam, and the disk analogue of `cgroupRoot`.
   *
   * A cgroup can be faked with a fixture directory; `statfs` cannot, so the volume's
   * figures are the one input a test cannot arrange. Defaults to the same `readDisk`
   * the metrics sampler calls — this is not a second reader, it is the one reader
   * behind a parameter.
   */
  diskReader?: (dataDir: string) => DiskReading;
  log?: (event: Record<string, unknown> & { message: string }) => void;
}

export class Watchdog {
  readonly #dataDir: string;
  readonly #notify: NotifyService;
  readonly #audit: AuditService;
  readonly #store: AlertStateStore;
  readonly #clock: Clock;
  readonly #cgroupRoot: string;
  readonly #memoryBand: Band;
  readonly #diskBand: Band;
  readonly #memoryPercent: number;
  readonly #diskPercent: number;
  readonly #cadenceMs: number;
  readonly #cooldownMs: number;
  readonly #startTimer: StartTimer;
  readonly #readDisk: (dataDir: string) => DiskReading;
  readonly #log: (event: Record<string, unknown> & { message: string }) => void;

  #timer: TimerHandle | null = null;
  /** This watcher's own previous CPU sample. Never shared — see the class comment. */
  #previousCpu: CpuSample | null = null;
  #startedAt: string;
  #lastSampledAt: string | null = null;
  #lastSource: MetricsSource | null = null;
  #lastMemoryPercent: number | null = null;
  #lastUsedBytes: number | null = null;
  #lastLimitBytes: number | null = null;
  #lastDiskPercent: number | null = null;
  #lastCpuPercent: number | null = null;
  #lastCpuWindowMs: number | null = null;
  #memoryReason: RuleStatus['reason'] = 'unavailable';
  #diskReason: RuleStatus['reason'] = 'unavailable';

  constructor(opts: WatchdogOptions) {
    this.#dataDir = opts.dataDir;
    this.#notify = opts.notify;
    this.#audit = opts.audit;
    this.#clock = opts.clock ?? systemClock;
    this.#store = new AlertStateStore({
      ...(opts.db ? { db: opts.db } : {}),
      clock: this.#clock,
    });
    this.#cgroupRoot = opts.cgroupRoot ?? CGROUP_V2_ROOT;
    this.#memoryBand = bandFromPercent(opts.memoryPercent ?? 85);
    this.#diskBand = bandFromPercent(opts.diskPercent ?? 80);
    this.#memoryPercent = Math.round(this.#memoryBand.alert * 100);
    this.#diskPercent = Math.round(this.#diskBand.alert * 100);
    this.#cadenceMs = opts.cadenceMs ?? WATCHDOG_CADENCE_MS;
    this.#cooldownMs = opts.cooldownMs ?? ALERT_COOLDOWN_MS;
    this.#startTimer = opts.startTimer ?? realInterval;
    this.#readDisk = opts.diskReader ?? readDisk;
    this.#log = opts.log ?? ((): void => {});
    this.#startedAt = isoFrom(this.#clock.now());
  }

  // ── Boot ───────────────────────────────────────────────────────────────────

  /**
   * Reads the previous run's marker, alerts if it was left behind, writes a fresh one.
   *
   * Separate from {@link start} so production can do the detection without the suite
   * arming a real 30 s timer in each of the hundreds of servers it builds — the same
   * split `NotifyService.sweepStale()` and `start()` already have.
   *
   * **What this can and cannot distinguish.** The panel installs SIGTERM and SIGINT
   * handlers (`app.ts`) which close the server and remove the marker, and Railway,
   * `docker stop` and a local Ctrl-C all send SIGTERM. So a normal redeploy is clean
   * and a SIGKILL is not, which is the distinction that makes this useful. What it
   * cannot separate is a container killed for memory from a redeploy whose graceful
   * shutdown overran the platform's grace period and was killed anyway — both leave the
   * marker. Hence the message says *did not shut down cleanly* and never *crashed*, and
   * carries the previous run's last memory reading so the operator can tell which it
   * probably was.
   */
  bootCheck(): UncleanRestart | null {
    const found = readMarker(this.#dataDir);
    let finding: UncleanRestart | null = null;

    if (found.present) {
      const marker = found.marker;
      const ranForSeconds =
        marker === null
          ? null
          : Math.max(
              0,
              Math.round((Date.parse(marker.lastSeenAt) - Date.parse(marker.startedAt)) / 1000),
            );
      finding = {
        previousStartedAt: marker?.startedAt ?? null,
        lastSeenAt: marker?.lastSeenAt ?? null,
        ranForSeconds: Number.isFinite(ranForSeconds) ? ranForSeconds : null,
        usedBytes: marker?.usedBytes ?? null,
        limitBytes: marker?.limitBytes ?? null,
        unreadable: marker === null,
      };

      // The row first, then the message. The log is what has to survive a Telegram
      // that is unreachable, and it is where "how often is this happening" is answered.
      this.#audit.write({
        event: AuditEvent.UncleanRestart,
        outcome: 'failure',
        meta: {
          previousStartedAt: finding.previousStartedAt,
          lastSeenAt: finding.lastSeenAt,
          ranForSeconds: finding.ranForSeconds,
          usedBytes: finding.usedBytes,
          limitBytes: finding.limitBytes,
          markerUnreadable: finding.unreadable,
        },
      });
      this.#notify.notify(
        {
          kind: 'unclean_restart',
          previousStartedAt: finding.previousStartedAt,
          lastSeenAt: finding.lastSeenAt,
          ranForSeconds: finding.ranForSeconds,
          usedBytes: finding.usedBytes,
          limitBytes: finding.limitBytes,
        },
        { throttleKey: 'panel.unclean_restart', throttleMs: EVENT_THROTTLE_MS },
      );
      this.#log({
        message: 'the previous run did not shut down cleanly',
        previousStartedAt: finding.previousStartedAt,
        lastSeenAt: finding.lastSeenAt,
        markerUnreadable: finding.unreadable,
      });
    }

    this.#startedAt = isoFrom(this.#clock.now());
    this.#writeMarker();
    return finding;
  }

  // ── The timer ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = this.#startTimer(() => this.tick(), this.#cadenceMs);
    // The first sample, so a crossing that is already true at boot is seen at the first
    // tick rather than at the second — and so `cpuRate` has a previous sample to work
    // from thirty seconds later.
    this.tick();
    this.#log({
      message: 'resource watchdog started',
      cadenceMs: this.#cadenceMs,
      memoryThresholdPercent: this.#memoryPercent,
      memoryArmed: this.#memoryReason === null,
      memoryDisabledBecause: this.#memoryReason,
      diskThresholdPercent: this.#diskPercent,
      diskArmed: this.#diskReason === null,
      oomKillArmed: this.#store.read().oomKills !== null,
    });
  }

  /**
   * Disarms the timer **and declares a clean shutdown** by removing the marker.
   *
   * The two are one method on purpose: the only caller is the `onClose` hook, and
   * `app.close()` is the panel's own definition of going down deliberately. A separate
   * "mark clean" that a future refactor could forget to call would turn every restart
   * into an alert, which is how a monitoring feature gets switched off within a day.
   */
  stop(): void {
    this.#timer?.stop();
    this.#timer = null;
    clearMarker(this.#dataDir);
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  // ── One sample ─────────────────────────────────────────────────────────────

  /** Never throws: it runs from a timer with nobody to catch it. */
  tick(): void {
    try {
      this.#sample();
    } catch (err) {
      this.#log({
        message: `resource watchdog tick failed: ${err instanceof Error ? err.name : 'unknown'}`,
      });
    }
  }

  #sample(): void {
    const atMs = this.#clock.now();
    const cgroup = cgroupV2Present(this.#cgroupRoot) ? readCgroup(this.#cgroupRoot) : null;
    const fromCgroup = cgroup !== null && cgroup.usedBytes !== null;
    const source: MetricsSource = fromCgroup ? 'cgroup2' : 'os';

    // ── Memory ───────────────────────────────────────────────────────────────
    //
    // The denominator is `memory.max` and nothing stands in for it. `os.totalmem()`
    // is the *host's* memory, so a fraction built from it on Railway would be a small
    // number all the way to the kill; and `memory.max` holding the literal `max` is a
    // cgroup with no ceiling, where a fraction is not a smaller number but an
    // undefined one. Both are the rule **disabled**, never defaulted.
    const usedBytes = fromCgroup ? cgroup.usedBytes : null;
    const limitBytes =
      cgroup !== null && cgroup.limit.kind === 'bytes' ? cgroup.limit.bytes : null;
    const memoryFraction =
      usedBytes !== null && limitBytes !== null && limitBytes > 0 ? usedBytes / limitBytes : null;
    this.#memoryReason =
      memoryFraction !== null
        ? null
        : cgroup !== null && cgroup.limit.kind === 'unlimited'
          ? 'no_limit'
          : 'unavailable';

    // ── Disk ─────────────────────────────────────────────────────────────────
    //
    // `(total - available) / total`, not `used / total`. `available` is `bavail` — the
    // field M2.4's import cap already reads — and the question this alert answers is
    // whether the panel can still *write*, for which a block reserved for root is not
    // space it has. On a filesystem with a reserve this reads a few points higher than
    // `df` for an unprivileged user, deliberately.
    const disk = this.#readDisk(this.#dataDir);
    const diskFraction =
      disk.totalBytes > 0 ? (disk.totalBytes - disk.availableBytes) / disk.totalBytes : null;
    this.#diskReason = diskFraction === null ? 'unavailable' : null;

    // ── CPU: recorded, never alerted on ──────────────────────────────────────
    //
    // No sustained-CPU rule, and the reason is not that it is hard. An agent waiting on
    // a model response is *idle*, so CPU is not this panel's binding constraint —
    // memory and the upstream API are — and a busy agent at 95 % is the product working.
    // An alert nobody can act on is what teaches an operator to ignore the channel that
    // also carries "someone signed in".
    //
    // It is still measured, because it is the figure that says what the panel was doing
    // when it died: the marker carries it, and the unclean-restart message is where it
    // is read.
    const quotaCores = cgroup !== null && cgroup.quota.kind === 'cores' ? cgroup.quota.cores : null;
    const usageUsec = cgroup !== null && cgroup.usage.kind === 'usec' ? cgroup.usage.usec : null;
    if (usageUsec !== null) {
      const rate = cpuRate(this.#previousCpu, { usageUsec, atMs }, quotaCores);
      this.#lastCpuPercent = rate.percentOfQuota;
      this.#lastCpuWindowMs = rate.sampleWindowMs;
      this.#previousCpu = { usageUsec, atMs };
    }

    // ── Decide ───────────────────────────────────────────────────────────────
    const previous = this.#store.read();
    const memory = evaluateCrossing(
      previous.memory,
      memoryFraction,
      this.#memoryBand,
      atMs,
      this.#cooldownMs,
    );
    const diskDecision = evaluateCrossing(
      previous.disk,
      diskFraction,
      this.#diskBand,
      atMs,
      this.#cooldownMs,
    );
    const oomReading = readOomKills(this.#cgroupRoot);
    const oom = evaluateOomKills(
      previous.oomKills,
      oomReading.kind === 'count' ? oomReading.kills : null,
    );

    // Persisted before the messages are enqueued, so a throw between the two cannot
    // produce the same alert on the next tick as well.
    this.#store.write(previous, {
      memory: memory.next,
      disk: diskDecision.next,
      oomKills: oom.next,
    });

    this.#lastSampledAt = isoFrom(atMs);
    this.#lastSource = source;
    this.#lastMemoryPercent = memoryFraction === null ? null : round1(memoryFraction * 100);
    this.#lastUsedBytes = usedBytes;
    this.#lastLimitBytes = limitBytes;
    this.#lastDiskPercent = diskFraction === null ? null : round1(diskFraction * 100);

    if (memory.emit !== null) {
      this.#emitCrossing('memory', memory.emit, {
        percent: this.#lastMemoryPercent ?? 0,
        thresholdPercent: this.#memoryPercent,
        usedBytes,
        limitBytes,
        since: previous.memory.since,
        atMs,
      });
    }
    if (diskDecision.emit !== null) {
      this.#emitCrossing('disk', diskDecision.emit, {
        percent: this.#lastDiskPercent ?? 0,
        thresholdPercent: this.#diskPercent,
        usedBytes: disk.totalBytes - disk.availableBytes,
        limitBytes: disk.totalBytes,
        since: previous.disk.since,
        atMs,
      });
    }
    if (oom.newKills > 0) {
      this.#emitOomKill(oom.newKills, oom.next ?? oom.newKills, usedBytes, limitBytes);
    }

    this.#writeMarker();
  }

  #emitCrossing(
    resource: 'memory' | 'disk',
    emit: 'alert' | 'recovery',
    figures: {
      percent: number;
      thresholdPercent: number;
      usedBytes: number | null;
      limitBytes: number | null;
      since: string | null;
      atMs: number;
    },
  ): void {
    const aboveForSeconds =
      emit === 'recovery' && figures.since !== null
        ? Math.max(0, Math.round((figures.atMs - Date.parse(figures.since)) / 1000))
        : null;

    this.#audit.write({
      event:
        emit === 'alert' ? AuditEvent.ResourceThresholdCrossed : AuditEvent.ResourceThresholdCleared,
      outcome: emit === 'alert' ? 'failure' : 'success',
      meta: {
        resource,
        percent: figures.percent,
        thresholdPercent: figures.thresholdPercent,
        usedBytes: figures.usedBytes,
        limitBytes: figures.limitBytes,
        aboveForSeconds,
      },
    });

    // No `throttleKey` here: the crossing machine already guarantees one message per
    // crossing, and its cooldown is the throttle. A second one on top would silence a
    // recovery, which is the message that makes the silence after an alert mean
    // something.
    this.#notify.notify({
      kind: 'resource_alert',
      resource,
      state: emit === 'alert' ? 'above' : 'cleared',
      percent: figures.percent,
      thresholdPercent: figures.thresholdPercent,
      usedBytes: figures.usedBytes,
      limitBytes: figures.limitBytes,
      aboveForSeconds,
    });
    this.#log({
      message: emit === 'alert' ? 'resource threshold crossed' : 'resource threshold cleared',
      resource,
      percent: figures.percent,
    });
  }

  #emitOomKill(
    newKills: number,
    totalKills: number,
    usedBytes: number | null,
    limitBytes: number | null,
  ): void {
    this.#audit.write({
      event: AuditEvent.ResourceOomKill,
      outcome: 'failure',
      meta: { newKills, totalKills, usedBytes, limitBytes },
    });
    this.#notify.notify(
      { kind: 'oom_kill', newKills, totalKills, usedBytes, limitBytes },
      { throttleKey: 'resource.oom_kill', throttleMs: EVENT_THROTTLE_MS },
    );
    this.#log({ message: 'processes were killed for memory', newKills, totalKills });
  }

  /**
   * The heartbeat.
   *
   * Rewritten every tick so the *next* boot can say when the previous run was last
   * alive and what it was using at the time — which is the whole difference between
   * "the panel restarted" and "the panel was using 1020 MB of its 1024 MB limit
   * thirty seconds before it stopped existing".
   */
  #writeMarker(): void {
    writeMarker(this.#dataDir, {
      startedAt: this.#startedAt,
      pid: process.pid,
      lastSeenAt: isoFrom(this.#clock.now()),
      usedBytes: this.#lastUsedBytes,
      limitBytes: this.#lastLimitBytes,
      cpuPercentOfQuota: this.#lastCpuPercent,
      source: this.#lastSource ?? 'os',
    });
  }

  status(): WatchdogStatus {
    const state = this.#store.read();
    return {
      running: this.running,
      cadenceMs: this.#cadenceMs,
      sampledAt: this.#lastSampledAt,
      source: this.#lastSource,
      memory: {
        armed: this.#memoryReason === null,
        reason: this.#memoryReason,
        thresholdPercent: this.#memoryPercent,
        clearPercent: Math.round(this.#memoryBand.clear * 100),
        state: state.memory.state,
        percent: this.#lastMemoryPercent,
      },
      disk: {
        armed: this.#diskReason === null,
        reason: this.#diskReason,
        thresholdPercent: this.#diskPercent,
        clearPercent: Math.round(this.#diskBand.clear * 100),
        state: state.disk.state,
        percent: this.#lastDiskPercent,
      },
      oomKills: state.oomKills,
      cpuPercentOfQuota: this.#lastCpuPercent,
      cpuSampleWindowMs: this.#lastCpuWindowMs,
    };
  }
}

const realInterval: StartTimer = (fn, ms) => {
  const timer = setInterval(fn, ms);
  // So the watchdog can never be the reason the process stays alive. A watcher that
  // held the event loop open would turn every shutdown into the thing it reports.
  timer.unref();
  return { stop: () => clearInterval(timer) };
};

/** One decimal place. A rounded number is still a number; a formatted one is a string. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
