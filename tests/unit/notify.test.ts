import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { closeDb, getDb, initDb } from '../../src/server/db.js';
import { SecretString, initCrypto, resetCrypto } from '../../src/server/crypto.js';
import { AuditEvent, AuditService } from '../../src/server/services/audit.service.js';
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  NotifyEventError,
  NotifyService,
  UNCONFIGURED_RETRY_MS,
  jitter,
} from '../../src/server/services/notify.service.js';
import type {
  NotificationTransport,
  OutboundText,
  SendOutcome,
  TransportFailure,
} from '../../src/server/services/telegram.transport.js';
import { FakeClock } from '../helpers/fake-clock.js';

const BASE = 'notify-base-path-sentinel';
const PATTERNED = `sk-ant-api03-${randomBytes(12).toString('hex')}`;

/** Records what it was asked to send and answers whatever the test set. */
class StubTransport implements NotificationTransport {
  readonly sent: OutboundText[] = [];
  outcome: SendOutcome = {
    ok: true,
    truncated: false,
    documentAttached: false,
    failure: null,
    retryAfterSeconds: null,
  };

  fail(failure: TransportFailure, retryAfterSeconds: number | null = null): void {
    this.outcome = { ok: false, truncated: false, documentAttached: false, failure, retryAfterSeconds };
  }

  async send(message: OutboundText): Promise<SendOutcome> {
    this.sent.push(message);
    return this.outcome;
  }
}

let dataDir: string;
let clock: FakeClock;
let audit: AuditService;
let transport: StubTransport;

function build(opts: { maxAttempts?: number; maxPending?: number } = {}): NotifyService {
  return new NotifyService({
    transport,
    audit,
    clock,
    basePath: BASE,
    // A fixed 0.5 puts the jitter exactly in the middle of its range, so the schedule is
    // the schedule and not a random number the assertion has to tolerate.
    random: () => 0.5,
    ...opts,
  });
}

function rows(): {
  id: number;
  state: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  event_json: string;
  throttle_key: string | null;
}[] {
  return getDb().prepare('SELECT * FROM notification_queue ORDER BY id').all() as never;
}

function auditEvents(): string[] {
  return (getDb().prepare('SELECT event FROM audit_log ORDER BY id').all() as { event: string }[]).map(
    (row) => row.event,
  );
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'panel-notify-'));
  initDb(join(dataDir, 'panel.db'));
  resetCrypto();
  initCrypto(randomBytes(32).toString('base64'));
  clock = new FakeClock();
  audit = new AuditService({ clock, basePath: BASE });
  transport = new StubTransport();
});

afterEach(() => {
  closeDb();
  resetCrypto();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('enqueue', () => {
  it('is one INSERT and never touches the transport', () => {
    const notify = build();
    const result = notify.notify({ kind: 'test', at: '2026-01-01T00:00:00.000Z' });

    expect(result).toEqual({ queued: 1, reason: 'queued' });
    expect(transport.sent).toHaveLength(0);
    expect(rows()[0]).toMatchObject({ state: 'pending', attempts: 0 });
    expect(notify.counts()).toEqual({ pending: 1, sending: 0, sent: 0, abandoned: 0 });
  });

  it('refuses a SecretString rather than redacting it', () => {
    const notify = build();
    const smuggled = {
      kind: 'turn_complete',
      projectId: 'p1',
      projectName: 'acme',
      outcome: 'finished',
      durationMs: 1,
      backgroundTasks: 0,
      message: new SecretString('sk-ant-secret') as unknown as string,
    } as never;

    // The same stance as `meta_json` validation: events are built from fixed shapes by
    // this application's own code, so a secret in one is a bug, and the loud version of a
    // bug is the one that gets fixed. A queue table that accumulates credentials is not
    // something to find out about months later.
    expect(() => notify.notify(smuggled)).toThrow(NotifyEventError);
    expect(rows()).toHaveLength(0);
  });

  it('redacts and elides at enqueue time, so the stored row is already clean', () => {
    const notify = build();
    notify.notify({
      kind: 'turn_complete',
      projectId: 'p1',
      projectName: 'acme-web',
      outcome: 'finished',
      durationMs: 252_000,
      backgroundTasks: 0,
      message: `token ${PATTERNED} while fetching /${BASE}/api/secrets`,
    });

    // Not "redacted on the way out": this table lives on the volume, so an un-elided copy
    // here would be worse than a log line rather than better.
    const stored = rows()[0]!.event_json;
    expect(stored).not.toContain(PATTERNED);
    expect(stored).not.toContain(BASE);
    expect(stored).toContain('[redacted]');
    expect(stored).toContain('<base>');
  });
});

describe('the worker', () => {
  it('sends, marks the row sent, and audits the outcome without the body', async () => {
    const notify = build();
    notify.notify({ kind: 'test', at: '2026-01-01T00:00:00.000Z' });

    const result = await notify.tick();
    expect(result).toMatchObject({ state: 'sent', attempts: 1 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.text).toContain('test message');

    expect(auditEvents()).toContain(AuditEvent.NotificationSent);
    const meta = JSON.parse(
      (
        getDb()
          .prepare('SELECT meta_json FROM audit_log WHERE event = ? ORDER BY id DESC LIMIT 1')
          .get(AuditEvent.NotificationSent) as { meta_json: string }
      ).meta_json,
    ) as Record<string, unknown>;
    // The row, the kind and the cost. Never the text — that is what the queue is for.
    expect(meta).toEqual({
      queueId: 1,
      kind: 'test',
      attempts: 1,
      truncated: false,
      documentAttached: false,
    });
    expect(JSON.stringify(meta)).not.toContain('test message');
  });

  it('backs off exponentially, capped and jittered', async () => {
    const notify = build();
    notify.notify({ kind: 'test', at: '2026-01-01T00:00:00.000Z' });
    transport.fail({ kind: 'rejected', category: 'other', errorCode: 500 });

    const delays: number[] = [];
    // Eleven, not twelve: the twelfth attempt is the cap and dead-letters rather than
    // rescheduling, which the next test is about.
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      const before = clock.now();
      const result = await notify.tick();
      if (result === null) break;
      const row = rows()[0]!;
      delays.push(Date.parse(row.next_attempt_at) - before);
      // Advance to when the row says it is due, so the next tick claims it.
      clock.set(Date.parse(row.next_attempt_at));
    }

    // 1s, 2s, 4s … capped at fifteen minutes. `random: () => 0.5` puts the ±20 % jitter
    // exactly in the middle, so these are the nominal values.
    expect(delays.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 16_000]);
    expect(delays.at(-1)).toBe(BACKOFF_CAP_MS);
    expect(Math.max(...delays)).toBe(BACKOFF_CAP_MS);
  });

  it('dead-letters after the attempt cap and keeps the row', async () => {
    const notify = build({ maxAttempts: 3 });
    notify.notify({ kind: 'test', at: '2026-01-01T00:00:00.000Z' });
    transport.fail({ kind: 'rejected', category: 'unknown_chat', errorCode: 400 });

    for (let i = 0; i < 3; i += 1) {
      await notify.tick();
      clock.set(Date.parse(rows()[0]!.next_attempt_at));
    }

    const row = rows()[0]!;
    expect(row.state).toBe('abandoned');
    expect(row.last_error).toBe('rejected:unknown_chat');
    expect(auditEvents()).toContain(AuditEvent.NotificationAbandoned);
    // Kept on purpose: "the panel tried to tell you and could not" is information, and
    // the queue is the only place it exists.
    expect(notify.counts().abandoned).toBe(1);
    // And it is not picked up again.
    expect(await notify.tick()).toBeNull();
  });

  it("uses Telegram's retry_after instead of the backoff, not as well as it", async () => {
    const notify = build();
    notify.notify({ kind: 'test', at: '2026-01-01T00:00:00.000Z' });
    transport.fail({ kind: 'rejected', category: 'rate_limited', errorCode: 429 }, 42);

    const before = clock.now();
    await notify.tick();

    expect(Date.parse(rows()[0]!.next_attempt_at) - before).toBe(42_000);
    expect(42_000).not.toBe(BACKOFF_BASE_MS);
  });

  it('never dead-letters for want of configuration, and gives the attempt back', async () => {
    const notify = build({ maxAttempts: 2 });
    notify.notify({ kind: 'test', at: '2026-01-01T00:00:00.000Z' });
    transport.fail({ kind: 'not_configured' });

    for (let i = 0; i < 5; i += 1) {
      const before = clock.now();
      await notify.tick();
      expect(Date.parse(rows()[0]!.next_attempt_at) - before).toBe(UNCONFIGURED_RETRY_MS);
      clock.advance(UNCONFIGURED_RETRY_MS);
    }

    // Five turns of the worker at a cap of two attempts, and the row is still pending:
    // "nobody has set this up yet" must not be the thing that discards a backlog of
    // security alerts. Configure it later and they drain.
    const row = rows()[0]!;
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.last_error).toBe('not_configured');
    expect(auditEvents()).not.toContain(AuditEvent.NotificationAbandoned);
  });

  it('honours a caller-supplied throttle window, for producers with no rule of their own', async () => {
    // The audit-derived alerts are throttled by `notification-rules.ts`. The watchdog's
    // OOM and unclean-restart alerts do not come through that path — nothing audit-shaped
    // produces them — so they carry their own key and window. Without this a container
    // that restarts every ten seconds enqueues one row per boot until the queue cap starts
    // refusing the security alerts that would say why.
    const notify = build();
    const first = notify.notify(
      { kind: 'test', at: '2026-01-01T00:00:00.000Z' },
      { throttleKey: 'watchdog.thing', throttleMs: 60_000 },
    );
    expect(first).toMatchObject({ reason: 'queued' });

    clock.advance(59_000);
    const second = notify.notify(
      { kind: 'test', at: '2026-01-01T00:00:59.000Z' },
      { throttleKey: 'watchdog.thing', throttleMs: 60_000 },
    );
    expect(second).toEqual({ queued: null, reason: 'throttled' });
    expect(rows()).toHaveLength(1);

    // Past the window it queues again — and a *different* key was never affected, because
    // a key is a bucket and not a global mute.
    clock.advance(2000);
    expect(
      notify.notify(
        { kind: 'test', at: '2026-01-01T00:01:01.000Z' },
        { throttleKey: 'watchdog.thing', throttleMs: 60_000 },
      ),
    ).toMatchObject({ reason: 'queued' });
    expect(
      notify.notify(
        { kind: 'test', at: '2026-01-01T00:01:01.000Z' },
        { throttleKey: 'watchdog.other', throttleMs: 60_000 },
      ),
    ).toMatchObject({ reason: 'queued' });
    expect(rows()).toHaveLength(3);

    // And a key with no window is not throttled at all, which is every other caller.
    for (let i = 0; i < 3; i += 1) {
      notify.notify({ kind: 'test', at: '2026-01-01T00:01:01.000Z' }, { throttleKey: 'watchdog.thing' });
    }
    expect(rows()).toHaveLength(6);
  });

  it('claims a row atomically, so two workers cannot both send it', async () => {
    const notify = build();
    notify.notify({ kind: 'test', at: '2026-01-01T00:00:00.000Z' });

    // Both ticks reach the claim before either awaits the transport.
    const [first, second] = await Promise.all([notify.tick(), notify.tick()]);

    expect(transport.sent).toHaveLength(1);
    expect([first, second].filter((r) => r !== null)).toHaveLength(1);
  });

  it('reclaims a row a crash left in flight, at the cost of a possible duplicate', () => {
    const notify = build();
    notify.notify({ kind: 'test', at: '2026-01-01T00:00:00.000Z' });
    getDb().prepare("UPDATE notification_queue SET state = 'sending', attempts = 1").run();

    expect(notify.sweepStale()).toEqual({ reclaimed: 1 });
    const row = rows()[0]!;
    expect(row.state).toBe('pending');
    // The attempt is *not* given back: a crash during a send may well have been caused by
    // the send, and a row that kills the process must still reach the cap.
    expect(row.attempts).toBe(1);
    // Delivery is therefore at-least-once. For a notification that is the right way
    // round: a duplicate is an annoyance, a lost security alert is a failed feature.
    expect(row.last_error).toBe('reclaimed_after_restart');
  });
});

describe('the queue cap', () => {
  it('refuses new events, keeps the old ones, and audits the fill exactly once', () => {
    const notify = build({ maxPending: 3 });
    for (let i = 0; i < 3; i += 1) notify.notify({ kind: 'test', at: `2026-01-01T00:00:0${i}.000Z` });

    const refused = [
      notify.notify({ kind: 'test', at: '2026-01-01T00:00:04.000Z' }),
      notify.notify({ kind: 'test', at: '2026-01-01T00:00:05.000Z' }),
    ];

    // The first alert of an attack is the most valuable thing in the queue and the newest
    // is the most expendable, so the new one is refused rather than the old one evicted.
    expect(refused).toEqual([
      { queued: null, reason: 'dropped' },
      { queued: null, reason: 'dropped' },
    ]);
    expect(notify.counts().pending).toBe(3);
    expect(notify.dropped().count).toBe(2);
    // One row per fill, not per refusal: a flood that fills the queue would otherwise
    // flood the audit log behind it, and the audit log is what must still work.
    expect(auditEvents().filter((e) => e === AuditEvent.NotificationDropped)).toHaveLength(1);
  });
});

describe('jitter', () => {
  it('stays within ±20 % and never goes negative', () => {
    expect(jitter(1000, 0.5)).toBe(1000);
    expect(jitter(1000, 0)).toBe(800);
    expect(jitter(1000, 1)).toBe(1200);
    expect(jitter(0, 0)).toBe(0);
  });
});
