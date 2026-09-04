import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { closeDb, getDb, initDb } from '../../src/server/db.js';
import { initCrypto, resetCrypto } from '../../src/server/crypto.js';
import { AuditEvent, AuditService, FailureReason } from '../../src/server/services/audit.service.js';
import { NOTIFICATION_RULES, ruleFor } from '../../src/server/services/notification-rules.js';
import { NotifyService } from '../../src/server/services/notify.service.js';
import type {
  NotificationTransport,
  OutboundText,
  SendOutcome,
} from '../../src/server/services/telegram.transport.js';
import { FakeClock } from '../helpers/fake-clock.js';

class SilentTransport implements NotificationTransport {
  async send(_message: OutboundText): Promise<SendOutcome> {
    void _message;
    return { ok: true, truncated: false, documentAttached: false, failure: null, retryAfterSeconds: null };
  }
}

let dataDir: string;
let clock: FakeClock;
let audit: AuditService;
let notify: NotifyService;

function queued(): { kind: string; event_json: string; throttle_key: string | null }[] {
  return getDb()
    .prepare('SELECT kind, event_json, throttle_key FROM notification_queue ORDER BY id')
    .all() as never;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'panel-rules-'));
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
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the rule map', () => {
  it('covers every audit event at runtime as well as at compile time', () => {
    // The `Record<AuditEventName, …>` is the compile-time half and is what actually stops
    // an event being added without a decision. This is the half that survives a cast, a
    // JSON parse, or an event name that only exists as a string somewhere.
    const events = Object.values(AuditEvent);
    expect(Object.keys(NOTIFICATION_RULES).sort()).toEqual([...events].sort());
    for (const event of events) {
      expect(ruleFor(event), event).not.toBeUndefined();
    }
  });

  it('says nothing about the events that would be noise, or a loop', () => {
    // Each of these is silent for a reason written on the line above it in the map; the
    // three notification events are the important ones — the transport cannot report its
    // own failure through itself.
    for (const event of [
      AuditEvent.SessionCreated,
      AuditEvent.SessionRevoked,
      AuditEvent.DelayApplied,
      AuditEvent.TwoFactorEnrollmentStarted,
      AuditEvent.OriginAbsentAdmitted,
      AuditEvent.NotificationSent,
      AuditEvent.NotificationAbandoned,
      AuditEvent.NotificationDropped,
    ]) {
      expect(ruleFor(event), event).toBeNull();
    }
  });
});

describe('audit events becoming notifications', () => {
  it('queues one message for a notified event and none for a silent one', () => {
    audit.write({ event: AuditEvent.LoginSuccess, outcome: 'success', meta: { sessionId: 1 } });
    audit.write({ event: AuditEvent.SessionCreated, outcome: 'success', meta: { sessionId: 1 } });

    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({ kind: 'security_alert', throttle_key: 'login.success' });
  });

  it('sends one message per window and carries the count it swallowed', () => {
    // A password spray produces one `login.failure` per attempt. Forwarding each one turns
    // the notification channel into the attack's amplifier and the phone into the thing
    // that gets denied service.
    for (let i = 0; i < 15; i += 1) {
      audit.write({
        event: AuditEvent.LoginFailure,
        outcome: 'failure',
        meta: { reason: FailureReason.BadCredentials },
      });
      clock.advance(1000);
    }

    expect(queued()).toHaveLength(1);
    const first = JSON.parse(queued()[0]!.event_json) as { suppressed: number; reason: string };
    expect(first.suppressed).toBe(0);
    expect(first.reason).toBe('bad_credentials');

    // Past the fifteen-minute window: one more message, carrying the count of everything
    // in between — read back from the audit log, which is the authority, rather than from
    // an in-memory tally a restart would lose.
    clock.advance(15 * 60_000);
    audit.write({
      event: AuditEvent.LoginFailure,
      outcome: 'failure',
      meta: { reason: FailureReason.BadCredentials },
    });

    expect(queued()).toHaveLength(2);
    const second = JSON.parse(queued()[1]!.event_json) as { suppressed: number };
    // Fourteen, from sixteen failures: the first was reported in its own message and this
    // one is being reported now, so fourteen is exactly what the window swallowed.
    expect(second.suppressed).toBe(14);
  });

  it('shares one window across the three authentication-failure events', () => {
    // "Someone is guessing" is one fact, not three, so a run that mixes a wrong password,
    // a wrong code and a spent recovery code is one message and one count.
    audit.write({ event: AuditEvent.LoginFailure, outcome: 'failure' });
    clock.advance(1000);
    audit.write({ event: AuditEvent.TotpFailure, outcome: 'failure' });
    clock.advance(1000);
    audit.write({ event: AuditEvent.RecoveryCodeUsed, outcome: 'success' });

    expect(queued()).toHaveLength(1);

    clock.advance(15 * 60_000);
    audit.write({ event: AuditEvent.TotpFailure, outcome: 'failure' });
    const second = JSON.parse(queued()[1]!.event_json) as { suppressed: number; event: string };
    expect(second.event).toBe(AuditEvent.TotpFailure);
    expect(second.suppressed).toBe(2);
  });

  it('never lets a notification failure break the audit write that caused it', () => {
    // The observer is called after the commit and its throw is swallowed, because the log
    // is the thing that has to survive. A rolled-back audit row for want of a queue INSERT
    // would be exactly the wrong way round.
    const broken = new NotifyService({
      transport: new SilentTransport(),
      audit,
      clock,
      db: {
        prepare: () => {
          throw new Error('database is gone');
        },
      } as never,
    });
    audit.setObserver((record) => broken.observeAudit(record));

    expect(() => audit.write({ event: AuditEvent.LoginSuccess, outcome: 'success' })).not.toThrow();
    expect(
      (getDb().prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }).c,
    ).toBeGreaterThan(0);
    expect(audit.verify().ok).toBe(true);
  });
});
