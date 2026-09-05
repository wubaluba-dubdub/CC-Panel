import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { closeDb, getDb, initDb } from '../../src/server/db.js';
import { initCrypto, resetCrypto } from '../../src/server/crypto.js';
import { AuditEvent, AuditService } from '../../src/server/services/audit.service.js';
import { NotifyService } from '../../src/server/services/notify.service.js';
import { ResourceSampler, type DiskReading, type StartTimer } from '../../src/server/services/resources.service.js';
import {
  markerPath,
  RUN_DIR,
  Watchdog,
  type RunMarker,
} from '../../src/server/services/watchdog.service.js';
import type {
  NotificationTransport,
  OutboundText,
  SendOutcome,
} from '../../src/server/services/telegram.transport.js';
import { FakeClock } from '../helpers/fake-clock.js';

/**
 * The watcher, against fixture cgroup trees and an injected volume.
 *
 * Nothing here reads this machine's own `/sys/fs/cgroup`: every interesting case is one
 * the machine running the suite cannot produce on demand — a `memory.max` of `max`, a
 * memory limit crossed and then recovered, an `oom_kill` counter that goes up, a volume
 * at 91 %. The one input a fixture directory cannot fake is `statfs`, so the volume
 * reading is a parameter with `readDisk` as its default.
 */

class SilentTransport implements NotificationTransport {
  async send(_message: OutboundText): Promise<SendOutcome> {
    void _message;
    return { ok: true, truncated: false, documentAttached: false, failure: null, retryAfterSeconds: null };
  }
}

const GIB = 1024 * 1024 * 1024;

let root: string;
let dataDir: string;
let clock: FakeClock;
let audit: AuditService;
let notify: NotifyService;

function cgroup(files: Record<string, string>): string {
  const dir = mkdtempSync(join(root, 'cg-'));
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  return dir;
}

/** A 1 GiB container at `usedBytes`, two cores, and an OOM counter. */
function container(
  usedBytes: number,
  opts: { limit?: string; usageUsec?: number; oomKill?: number | null } = {},
): string {
  const files: Record<string, string> = {
    'cgroup.controllers': 'cpuset cpu io memory pids\n',
    'memory.current': `${usedBytes}\n`,
    'memory.max': opts.limit ?? `${GIB}\n`,
    'cpu.max': '200000 100000\n',
    'cpu.stat': `usage_usec ${opts.usageUsec ?? 0}\nuser_usec 1\n`,
  };
  if (opts.oomKill !== null) {
    files['memory.events'] =
      `low 0\nhigh 0\nmax 3\noom 1\noom_kill ${opts.oomKill ?? 0}\noom_group_kill 0\n`;
  }
  return cgroup(files);
}

function setMemory(dir: string, usedBytes: number): void {
  writeFileSync(join(dir, 'memory.current'), `${usedBytes}\n`);
}

function setOomKills(dir: string, kills: number): void {
  writeFileSync(join(dir, 'memory.events'), `low 0\nhigh 0\noom 1\noom_kill ${kills}\n`);
}

/** A volume at a chosen fraction, since `statfs` cannot be arranged. */
function volumeAt(fraction: number): (dataDir: string) => DiskReading {
  return (path: string) => ({
    path,
    totalBytes: 100 * GIB,
    usedBytes: Math.round(fraction * 100 * GIB),
    availableBytes: Math.round((1 - fraction) * 100 * GIB),
    databaseBytes: 4096,
  });
}

function build(opts: {
  cgroupRoot?: string;
  diskReader?: (dataDir: string) => DiskReading;
  memoryPercent?: number;
  diskPercent?: number;
  clearWindowMs?: number;
  cadenceMs?: number;
  startTimer?: StartTimer;
}): Watchdog {
  return new Watchdog({
    dataDir,
    notify,
    audit,
    clock,
    // Below every default threshold, so a test that is not about disk never trips it.
    diskReader: opts.diskReader ?? volumeAt(0.1),
    ...opts,
  });
}

function queued(): { kind: string; event_json: string; throttle_key: string | null }[] {
  return getDb()
    .prepare('SELECT kind, event_json, throttle_key FROM notification_queue ORDER BY id')
    .all() as never;
}

function events<T>(kind: string): T[] {
  return queued()
    .filter((row) => row.kind === kind)
    .map((row) => JSON.parse(row.event_json) as T);
}

function auditEvents(): string[] {
  return (getDb().prepare('SELECT event FROM audit_log ORDER BY id').all() as { event: string }[]).map(
    (r) => r.event,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'panel-watchdog-cg-'));
  dataDir = mkdtempSync(join(tmpdir(), 'panel-watchdog-'));
  mkdirSync(join(dataDir, RUN_DIR), { recursive: true });
  initDb(join(dataDir, 'panel.db'));
  resetCrypto();
  initCrypto(randomBytes(32).toString('base64'));
  clock = new FakeClock();
  audit = new AuditService({ clock });
  notify = new NotifyService({ transport: new SilentTransport(), audit, clock });
  audit.setObserver((record) => notify.observeAudit(record));
});

afterEach(() => {
  closeDb();
  resetCrypto();
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the memory rule', () => {
  it('alerts once on a crossing and once on the recovery, whatever happens between', () => {
    const dir = container(0.5 * GIB);
    const watchdog = build({ cgroupRoot: dir });

    watchdog.tick();
    expect(queued()).toHaveLength(0);
    expect(watchdog.status().memory.percent).toBe(50);

    // Over the line, and then held there for ten minutes of sampling.
    setMemory(dir, Math.round(0.91 * GIB));
    for (let i = 0; i < 20; i += 1) {
      clock.advance(30_000);
      watchdog.tick();
    }
    const alerts = events<{ state: string; percent: number; thresholdPercent: number }>(
      'resource_alert',
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ state: 'above', thresholdPercent: 85 });
    expect(alerts[0]!.percent).toBeCloseTo(91, 0);
    expect(auditEvents().filter((e) => e === AuditEvent.ResourceThresholdCrossed)).toHaveLength(1);

    // Into the band. Neither a new alert nor a recovery: 80 % is not "back to normal".
    setMemory(dir, Math.round(0.8 * GIB));
    clock.advance(30_000);
    watchdog.tick();
    expect(events('resource_alert')).toHaveLength(1);
    expect(watchdog.status().memory.state).toBe('above');

    // Below the clear threshold. **Not yet a recovery**: the reading has to stay there for
    // the clear window, which is what stops the operator's last message from being a
    // "recovered" that a re-crossing five minutes later would silently contradict.
    setMemory(dir, Math.round(0.6 * GIB));
    clock.advance(30_000);
    watchdog.tick();
    expect(events('resource_alert')).toHaveLength(1);
    expect(watchdog.status().memory.state).toBe('above');
    expect(watchdog.status().memory.clearingSince).not.toBeNull();

    // Sixty more ticks — half an hour — with the reading still low. Now it recovers, once.
    for (let i = 0; i < 60; i += 1) {
      clock.advance(30_000);
      watchdog.tick();
    }
    const both = events<{ state: string; aboveForSeconds: number | null }>('resource_alert');
    expect(both).toHaveLength(2);
    expect(both[1]!.state).toBe('cleared');
    // Crossed on the first tick after the memory was raised (t = 30 s); the reading went
    // below the clear line at t = 660 s and the window elapsed at t = 2460 s, so the rule
    // was `above` for 2430 s. The duration is measured from the crossing and not from the
    // dip, deliberately: that is how long the condition actually held.
    expect(both[1]!.aboveForSeconds).toBe(2430);
    expect(auditEvents()).toContain(AuditEvent.ResourceThresholdCleared);
    expect(watchdog.status().memory.state).toBe('below');
    expect(watchdog.status().memory.clearingSince).toBeNull();
    expect(watchdog.status().memory.alertedAt).toBeNull();
  });

  it('does not recover after a dip that comes back up, and never says it did', () => {
    // The M1.8 sequence, end to end through the real watcher: cross, drop, cross back
    // inside the clear window, then stay high. The old machine sent a recovery on the drop
    // and suppressed the re-crossing with its cooldown, leaving "back to normal" as the
    // operator's most recent message about a rule that was above and staying there.
    const dir = container(Math.round(0.91 * GIB));
    const watchdog = build({ cgroupRoot: dir });
    watchdog.tick();
    expect(events<{ state: string }>('resource_alert').map((e) => e.state)).toEqual(['above']);

    // Ten minutes below the clear line — a third of the window, no recovery.
    setMemory(dir, Math.round(0.4 * GIB));
    for (let i = 0; i < 20; i += 1) {
      clock.advance(30_000);
      watchdog.tick();
    }
    expect(events('resource_alert')).toHaveLength(1);

    // Back over the threshold, and held there for an hour.
    setMemory(dir, Math.round(0.95 * GIB));
    for (let i = 0; i < 120; i += 1) {
      clock.advance(30_000);
      watchdog.tick();
    }

    // Exactly one message in the whole sequence, and it is the alert.
    const messages = events<{ state: string }>('resource_alert');
    expect(messages.map((e) => e.state)).toEqual(['above']);
    expect(watchdog.status().memory.state).toBe('above');
    expect(watchdog.status().memory.clearingSince).toBeNull();
    expect(watchdog.status().memory.alertedAt).not.toBeNull();
  });

  it('survives a restart mid-crossing without re-alerting, because the state is on the volume', () => {
    const dir = container(Math.round(0.9 * GIB));
    build({ cgroupRoot: dir }).tick();
    expect(events('resource_alert')).toHaveLength(1);

    // A new Watchdog against the same database is a new process against the same volume.
    // The crossing state is a row, not a field, so it does not start again from `below`.
    const second = build({ cgroupRoot: dir });
    clock.advance(30_000);
    second.tick();
    expect(events('resource_alert')).toHaveLength(1);
    expect(second.status().memory.state).toBe('above');
  });

  it('is disabled and not defaulted when memory.max is the literal max', () => {
    // No denominator. The operator learns this from the boot log line and from
    // `npm run preflight`, which reads the real cgroup and says the rule cannot arm —
    // there is no silent "0 %" and no fraction of the host's memory standing in for it.
    const dir = container(950 * 1024 * 1024, { limit: 'max\n' });
    const watchdog = build({ cgroupRoot: dir });

    for (let i = 0; i < 10; i += 1) {
      clock.advance(30_000);
      watchdog.tick();
    }

    expect(events('resource_alert')).toHaveLength(0);
    const status = watchdog.status();
    expect(status.memory.armed).toBe(false);
    expect(status.memory.reason).toBe('no_limit');
    expect(status.memory.percent).toBeNull();
    // And the rules that have a denominator are untouched by it.
    expect(status.disk.armed).toBe(true);
  });

  it('is disabled when there is no cgroup v2 at all, rather than using the host figures', () => {
    const watchdog = build({ cgroupRoot: join(root, 'nothing-here') });
    watchdog.tick();
    expect(events('resource_alert')).toHaveLength(0);
    expect(watchdog.status().memory.armed).toBe(false);
    expect(watchdog.status().memory.reason).toBe('unavailable');
    expect(watchdog.status().source).toBe('os');
  });
});

describe('the disk rule', () => {
  it('measures what the panel can write, not what df calls used', () => {
    // `(total - available) / total`. `available` is `bavail`, so a block reserved for root
    // is not space the panel has — which is the question the alert answers.
    const watchdog = build({ diskReader: volumeAt(0.91) });
    watchdog.tick();

    const alerts = events<{ resource: string; state: string; percent: number; usedBytes: number; limitBytes: number }>(
      'resource_alert',
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ resource: 'disk', state: 'above', percent: 91 });
    expect(alerts[0]!.limitBytes).toBe(100 * GIB);
    expect(alerts[0]!.usedBytes).toBe(Math.round(0.91 * 100 * GIB));
  });

  it('has its own threshold, ten points lower than memory, and its own state', () => {
    const watchdog = build({ diskReader: volumeAt(0.82) });
    watchdog.tick();
    // 82 % is above the disk threshold of 80 and below the memory one of 85: the two rules
    // are not one rule with two numbers.
    expect(events<{ resource: string }>('resource_alert').map((e) => e.resource)).toEqual(['disk']);
    expect(watchdog.status().disk.thresholdPercent).toBe(80);
    expect(watchdog.status().disk.clearPercent).toBe(70);
  });
});

describe('an alert that was never delivered', () => {
  it('clears in silence, because a recovery for it would be a message about nothing', () => {
    // `alerted` is what keeps *silence* unambiguous, and since M2.1 the crossing machine
    // always sets it on entering `above` — there is no cooldown left to swallow an alert.
    // The one thing that can still go wrong is delivery: a full queue refuses the newest
    // event. The operator then has no record of the alert, so a "back to normal" would be
    // a message about something they never saw.
    const dir = container(Math.round(0.95 * GIB));
    // A queue with room for one row, and that row spent before the watchdog runs. The cap
    // is floored at 1 by `NotifyService`, so "full" has to be arranged rather than
    // configured to zero. `notify()` then returns `{queued: null}`, counts the drop and
    // audits it — and the watchdog reads the return value rather than assuming it worked.
    const full = new NotifyService({
      transport: new SilentTransport(),
      audit,
      clock,
      maxPending: 1,
    });
    expect(full.notify({ kind: 'test', at: '2026-01-01T00:00:00.000Z' }).queued).not.toBeNull();
    const watchdog = new Watchdog({
      dataDir,
      notify: full,
      audit,
      clock,
      cgroupRoot: dir,
      diskReader: volumeAt(0.1),
    });

    watchdog.tick();
    // The audit row is written whatever the queue does — the log is the authority.
    expect(auditEvents()).toContain(AuditEvent.ResourceThresholdCrossed);
    expect(queued().filter((row) => row.kind === 'resource_alert')).toHaveLength(0);
    // And the rule records that the operator was *not* told.
    expect(watchdog.status().memory.state).toBe('above');
    expect(watchdog.status().memory.alertedAt).toBeNull();

    // Now let the condition end, for well over the clear window. No recovery is sent.
    setMemory(dir, Math.round(0.4 * GIB));
    for (let i = 0; i < 80; i += 1) {
      clock.advance(30_000);
      watchdog.tick();
    }
    expect(watchdog.status().memory.state).toBe('below');
    expect(queued().filter((row) => row.kind === 'resource_alert')).toHaveLength(0);
    // The clearing is still recorded in the log, which is where "what happened" lives.
    expect(auditEvents()).toContain(AuditEvent.ResourceThresholdCleared);
  });
});

describe('OOM kills', () => {
  it('adopts the counter on the first sample and reports every increase after it', () => {
    const dir = container(0.5 * GIB, { oomKill: 4 });
    const watchdog = build({ cgroupRoot: dir });

    // Four kills already on the counter when the panel first looks. Not news: they
    // happened before this process, possibly before this build.
    watchdog.tick();
    expect(queued()).toHaveLength(0);
    expect(watchdog.status().oom.kills).toBe(4);

    // Two more processes killed. `oom_kill` counts processes, so this is one message
    // saying two — which is exactly the concurrency policy's scenario of several agents
    // inside one gigabyte.
    setOomKills(dir, 6);
    clock.advance(30_000);
    watchdog.tick();

    const kills = events<{ newKills: number; totalKills: number }>('oom_kill');
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({ newKills: 2, totalKills: 6 });
    expect(auditEvents()).toContain(AuditEvent.ResourceOomKill);
  });

  it('writes the audit row for every increase and throttles only the message', () => {
    const dir = container(0.5 * GIB, { oomKill: 0 });
    const watchdog = build({ cgroupRoot: dir });
    watchdog.tick();

    for (const total of [1, 2, 3]) {
      setOomKills(dir, total);
      clock.advance(30_000);
      watchdog.tick();
    }

    // The log is the authority and records all three; the phone gets one, because a
    // crash-looping agent should not be able to fill the queue that also carries the
    // security alerts telling the operator why.
    expect(auditEvents().filter((e) => e === AuditEvent.ResourceOomKill)).toHaveLength(3);
    expect(events('oom_kill')).toHaveLength(1);
  });

  it('takes a container restart as a new counter rather than a negative delta', () => {
    const dir = container(0.5 * GIB, { oomKill: 9 });
    const watchdog = build({ cgroupRoot: dir });
    watchdog.tick();

    setOomKills(dir, 0);
    clock.advance(30_000);
    watchdog.tick();
    expect(events('oom_kill')).toHaveLength(0);
    expect(watchdog.status().oom.kills).toBe(0);

    // And the next real kill in the new cgroup is reported against the new baseline.
    setOomKills(dir, 1);
    clock.advance(30_000);
    watchdog.tick();
    expect(events<{ newKills: number }>('oom_kill')[0]).toMatchObject({ newKills: 1 });
  });

  it('says nothing when the counter is not exposed, rather than reading it as zero', () => {
    const dir = container(0.5 * GIB, { oomKill: null });
    const watchdog = build({ cgroupRoot: dir });
    watchdog.tick();
    clock.advance(30_000);
    watchdog.tick();
    expect(events('oom_kill')).toHaveLength(0);
    expect(watchdog.status().oom.kills).toBeNull();
  });
});

describe('the run marker', () => {
  it('writes a marker at boot and removes it on a graceful shutdown', () => {
    const watchdog = build({ cgroupRoot: container(0.5 * GIB) });
    expect(existsSync(markerPath(dataDir))).toBe(false);

    expect(watchdog.bootCheck()).toBeNull();
    expect(existsSync(markerPath(dataDir))).toBe(true);
    expect(queued()).toHaveLength(0);

    watchdog.stop();
    expect(existsSync(markerPath(dataDir))).toBe(false);
  });

  it('reports the previous run when the marker is still there, with what it left behind', () => {
    const previous: RunMarker = {
      startedAt: '2026-01-01T00:00:00.000Z',
      pid: 41,
      lastSeenAt: '2026-01-01T02:12:30.000Z',
      usedBytes: 1_020_000_000,
      limitBytes: GIB,
      cpuPercentOfQuota: 12.5,
      source: 'cgroup2',
    };
    writeFileSync(markerPath(dataDir), JSON.stringify(previous));

    clock.set(Date.parse('2026-01-01T02:13:00.000Z'));
    const finding = build({ cgroupRoot: container(0.5 * GIB) }).bootCheck();

    expect(finding).toMatchObject({
      previousStartedAt: previous.startedAt,
      lastSeenAt: previous.lastSeenAt,
      ranForSeconds: 2 * 3600 + 12 * 60 + 30,
      usedBytes: 1_020_000_000,
      unreadable: false,
    });

    // The memory reading is the whole point of the heartbeat: 1020 MB of 1024 MB thirty
    // seconds before the process stopped existing is an OOM kill, and nothing else in the
    // system remembers it.
    const alerts = events<{ usedBytes: number; ranForSeconds: number }>('unclean_restart');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.usedBytes).toBe(1_020_000_000);
    expect(auditEvents()).toContain(AuditEvent.UncleanRestart);

    // A fresh marker replaced it, so this boot is now the one being watched.
    const written = JSON.parse(readFileSync(markerPath(dataDir), 'utf-8')) as RunMarker;
    expect(written.startedAt).not.toBe(previous.startedAt);
    expect(written.pid).toBe(process.pid);
  });

  it('treats a torn marker as an unclean restart with no detail, not as a clean one', () => {
    writeFileSync(markerPath(dataDir), '{"startedAt":"2026-01-01T00:0');

    const finding = build({ cgroupRoot: container(0.5 * GIB) }).bootCheck();
    expect(finding).toMatchObject({ unreadable: true, previousStartedAt: null, lastSeenAt: null });
    expect(events('unclean_restart')).toHaveLength(1);
  });

  it('reports a crash loop once per window rather than once per boot', () => {
    // Ten boots in two minutes, nine of which find a marker the previous one left behind.
    // One message. Without the throttle it is nine, and a container that restarts every
    // ten seconds for an hour would reach the queue cap — at which point it is the
    // security alerts that get refused to make room for the noise.
    for (let i = 0; i < 10; i += 1) {
      build({ cgroupRoot: container(0.5 * GIB) }).bootCheck();
      clock.advance(12_000);
    }
    expect(events('unclean_restart')).toHaveLength(1);
    // The log still has all nine, because the log is where "how often is this happening"
    // is answered and the throttle is only about the phone.
    expect(auditEvents().filter((e) => e === AuditEvent.UncleanRestart)).toHaveLength(9);

    // And past the window, the next one is reported again — a panel that is still
    // crash-looping half an hour later has not stopped being worth a message.
    clock.advance(31 * 60_000);
    build({ cgroupRoot: container(0.5 * GIB) }).bootCheck();
    expect(events('unclean_restart')).toHaveLength(2);
  });

  it('keeps a heartbeat, so the next boot knows when the previous run was last alive', () => {
    const dir = container(Math.round(0.5 * GIB), { usageUsec: 0 });
    const watchdog = build({ cgroupRoot: dir });
    watchdog.bootCheck();

    const atBoot = JSON.parse(readFileSync(markerPath(dataDir), 'utf-8')) as RunMarker;
    clock.advance(30_000);
    setMemory(dir, 700_000_000);
    watchdog.tick();

    const later = JSON.parse(readFileSync(markerPath(dataDir), 'utf-8')) as RunMarker;
    expect(Date.parse(later.lastSeenAt)).toBe(Date.parse(atBoot.lastSeenAt) + 30_000);
    expect(later.startedAt).toBe(atBoot.startedAt);
    expect(later.usedBytes).toBe(700_000_000);
  });
});

describe('the watcher and the metrics sampler are independent', () => {
  it('each divides its own delta by its own interval', () => {
    // **The failure this rules out is not a crash.** Two consumers sharing one
    // previous-sample slot would each divide their delta by the other's interval, and at
    // 1000 ms against 30 000 ms the answer would be wrong by a factor of thirty — still a
    // number, still in range, still plausible on a dashboard. The arithmetic is a pure
    // function taking `previous` as an argument for exactly this reason, and both of these
    // point at the same fixture so the assertion is not vacuous.
    const dir = container(0.5 * GIB, { usageUsec: 0 });
    const sampler = new ResourceSampler({
      dataDir,
      clock,
      cgroupRoot: dir,
      // Never armed: the test drives `sample()` by hand.
      startTimer: () => ({ stop: () => {} }),
    });
    const watchdog = build({ cgroupRoot: dir });

    // Both take their first reading at t=0.
    sampler.snapshot();
    watchdog.tick();

    // One second later, one second of CPU has been used. Two cores of quota, so 50 %.
    clock.advance(1000);
    writeFileSync(join(dir, 'cpu.stat'), 'usage_usec 1000000\n');
    sampler.sample();
    expect(sampler.peek()!.cpu.percentOfQuota).toBe(50);
    expect(sampler.peek()!.cpu.sampleWindowMs).toBe(1000);

    // Twenty-nine seconds after that, twelve more seconds of CPU. The watchdog's own
    // previous sample is the one from t=0, so its window is the full thirty seconds and
    // its answer is 13 s of CPU over 30 s × 2 cores = 21.67 %.
    clock.advance(29_000);
    writeFileSync(join(dir, 'cpu.stat'), 'usage_usec 13000000\n');
    watchdog.tick();
    expect(watchdog.status().cpuSampleWindowMs).toBe(30_000);
    expect(watchdog.status().cpuPercentOfQuota).toBeCloseTo(21.67, 1);

    // And the sampler is untouched by the watchdog having sampled: its next reading is
    // measured from *its* previous one, a second ago, not from the watchdog's.
    clock.advance(1000);
    writeFileSync(join(dir, 'cpu.stat'), 'usage_usec 14000000\n');
    sampler.sample();
    expect(sampler.peek()!.cpu.sampleWindowMs).toBe(30_000);
    expect(sampler.peek()!.cpu.percentOfQuota).toBeCloseTo(21.67, 1);
  });

  it('does not alert from the sampler, and does not serve requests from the watcher', () => {
    // The division of labour, asserted rather than assumed: the poll-driven sampler has no
    // way to enqueue anything, and the watcher never produces the endpoint's snapshot.
    const dir = container(Math.round(0.95 * GIB));
    const sampler = new ResourceSampler({ dataDir, clock, cgroupRoot: dir, startTimer: () => ({ stop: () => {} }) });

    for (let i = 0; i < 5; i += 1) {
      clock.advance(1000);
      sampler.sample();
    }
    expect(queued()).toHaveLength(0);

    build({ cgroupRoot: dir }).tick();
    expect(events('resource_alert')).toHaveLength(1);
  });
});
