import { AuditEvent, type AuditEventName } from './audit.service.js';

/**
 * Which audit events are worth a message on the operator's phone, in one file.
 *
 * Not scattered through the handlers, for two reasons. The answer to "what does this
 * panel tell me about?" should be one readable file; and an event must never become
 * *silently* unmonitored, so the map is exhaustive over `AuditEvent` and an event with
 * no rule has to say `null` **with a reason on the line above it**. Adding an audit
 * event without deciding this stops compiling.
 *
 * The `satisfies` rather than a type annotation is deliberate: it keeps the literal
 * types, which is what lets {@link NotifiedAuditEvent} below be the exact subset that
 * notifies — so a new notifying event also has to be given a headline in
 * `notification-render.ts`, in both languages, or that fails to compile too.
 */
export interface AlertRule {
  /**
   * The throttle bucket. Events sharing a key share one message and one count, which
   * is how a mixed password-and-code spray produces one alert rather than two.
   */
  readonly throttleKey: string;
  /** One message per key per window. `0` means never throttled. */
  readonly throttleMs: number;
  /**
   * Which events the suppressed count is counted over. Defaults to the event itself.
   * The count comes from the audit log, which is the authority — not from an in-memory
   * tally a restart would lose.
   */
  readonly countEvents?: readonly AuditEventName[];
}

const FIFTEEN_MINUTES = 15 * 60_000;
const ONE_DAY = 24 * 60 * 60_000;

/** Shared by both authentication-failure events. */
const AUTH_FAILURE_EVENTS = [
  AuditEvent.LoginFailure,
  AuditEvent.TotpFailure,
  AuditEvent.RecoveryCodeUsed,
] as const;

export const NOTIFICATION_RULES = {
  // ── Notified, unthrottled: rare, and each one is either the operator doing
  //    something deliberate or somebody else doing it for them.
  //
  // A successful login is the single most valuable alert this panel can send: there is
  // exactly one legitimate user, so a login the operator did not perform is the whole
  // story in one line.
  [AuditEvent.LoginSuccess]: { throttleKey: 'login.success', throttleMs: 0 },
  [AuditEvent.SetupCompleted]: { throttleKey: 'setup.completed', throttleMs: 0 },
  [AuditEvent.PasswordChanged]: { throttleKey: 'password.changed', throttleMs: 0 },
  [AuditEvent.TwoFactorDisabled]: { throttleKey: 'two_factor.disabled', throttleMs: 0 },
  [AuditEvent.RecoveryCodesRegenerated]: { throttleKey: 'recovery_codes', throttleMs: 0 },
  [AuditEvent.BasePathRegenerated]: { throttleKey: 'base_path', throttleMs: 0 },

  // ── Notified, throttled ──────────────────────────────────────────────────────
  //
  // A spray produces one `login.failure` per attempt. Forwarding each one turns the
  // notification channel into the attack's amplifier and the operator's phone into the
  // thing that gets denied service — so one message per fifteen minutes carrying the
  // count suppressed in that window, counted across all three failure events because
  // "someone is guessing" is one fact and not three.
  [AuditEvent.LoginFailure]: {
    throttleKey: 'auth.failure',
    throttleMs: FIFTEEN_MINUTES,
    countEvents: AUTH_FAILURE_EVENTS,
  },
  [AuditEvent.TotpFailure]: {
    throttleKey: 'auth.failure',
    throttleMs: FIFTEEN_MINUTES,
    countEvents: AUTH_FAILURE_EVENTS,
  },
  // A recovery code is the break-glass path and should be used roughly never, so it is
  // notified — but it shares the failure window, because a code being spent during a
  // spray is part of the same story.
  [AuditEvent.RecoveryCodeUsed]: {
    throttleKey: 'auth.failure',
    throttleMs: FIFTEEN_MINUTES,
    countEvents: AUTH_FAILURE_EVENTS,
  },
  // Step-up needs the password *and* a fresh code, so one the operator did not perform
  // is an emergency. Throttled anyway: an operator working through the settings screens
  // steps up once and then does five things, and five identical messages in a minute is
  // how an alert channel gets muted.
  [AuditEvent.StepUpGranted]: { throttleKey: 'stepup.granted', throttleMs: FIFTEEN_MINUTES },
  // Reading and writing stored credentials. Throttled, because an attacker dumping
  // every secret should produce one message and a count rather than one per secret —
  // and because the M2.4 settings screens will write several in a row legitimately.
  [AuditEvent.SecretRevealed]: { throttleKey: 'secret.revealed', throttleMs: FIFTEEN_MINUTES },
  [AuditEvent.SecretChanged]: { throttleKey: 'secret.changed', throttleMs: FIFTEEN_MINUTES },
  // Retention trimming the audit log is housekeeping, but it is also exactly what a
  // tamper would like to look like, so it is not silent. A day's window rather than
  // fifteen minutes: once the cap is reached, *every* retention check trims again, so a
  // busy panel would otherwise send this every few hundred events forever.
  [AuditEvent.AuditTrimmed]: { throttleKey: 'audit.trimmed', throttleMs: ONE_DAY },

  // ── Silent, each with its reason ─────────────────────────────────────────────
  //
  // Implied by the login that created it, which is notified.
  [AuditEvent.SessionCreated]: null,
  // Implied by the action that caused it — a password change reports the count of
  // sessions it revoked in its own message.
  [AuditEvent.SessionRevoked]: null,
  // The delay is the interesting part of a failure and the failure row already carries
  // it; notifying both would double every failed attempt.
  [AuditEvent.DelayApplied]: null,
  // Enrolment starting is not news; `setup.completed` is.
  [AuditEvent.TwoFactorEnrollmentStarted]: null,
  // Already throttled to one row per fifteen minutes in the audit layer, and it means
  // "a non-browser client used the API", which is a curiosity rather than a wake-up.
  [AuditEvent.OriginAbsentAdmitted]: null,
  // The transport cannot report its own failure through itself. A send that succeeded
  // needs no message — the operator is holding it — and a send that was abandoned or
  // dropped would enqueue another message into the queue that is already not draining.
  [AuditEvent.NotificationSent]: null,
  [AuditEvent.NotificationAbandoned]: null,
  [AuditEvent.NotificationDropped]: null,
  // ── The watchdog's four, and they are silent *here* rather than unnotified ────
  //
  // Each of these already reaches the operator, and by a better route: the watchdog
  // enqueues its own typed event with the numbers in it. A rule here would turn the
  // audit row into a `security_alert`, whose shape is a headline plus a time — so the
  // operator would get "memory crossed a threshold" and *not* "940 MB of 1 GB, the
  // threshold is 85 %", which is the entire content. Worse, they would get both.
  //
  // So the row is written for the log, which is where "when did this start happening"
  // is answered, and the message is enqueued directly. This is the one place in the
  // map where `null` means "notified elsewhere" rather than "not worth notifying", and
  // it is spelled out because a future reader deciding whether to add a rule here
  // would otherwise be looking at four of the most alert-worthy events in the panel
  // marked silent.
  [AuditEvent.ResourceThresholdCrossed]: null,
  [AuditEvent.ResourceThresholdCleared]: null,
  [AuditEvent.ResourceOomKill]: null,
  [AuditEvent.UncleanRestart]: null,
} satisfies Record<AuditEventName, AlertRule | null>;

/**
 * Exactly the events that produce a message.
 *
 * Derived from the map above rather than listed again, so the renderer's headline
 * dictionaries cover this set and nothing else — no unused Persian string for an event
 * that is silent, and no missing one for an event that is not.
 */
export type NotifiedAuditEvent = {
  [K in keyof typeof NOTIFICATION_RULES]: (typeof NOTIFICATION_RULES)[K] extends null ? never : K;
}[keyof typeof NOTIFICATION_RULES];

export function ruleFor(event: AuditEventName): AlertRule | null {
  return NOTIFICATION_RULES[event];
}

/** The events counted in one throttle window, for the suppressed figure. */
export function countedEventsFor(event: NotifiedAuditEvent): readonly AuditEventName[] {
  const rule = NOTIFICATION_RULES[event] as AlertRule;
  return rule.countEvents ?? [event];
}
