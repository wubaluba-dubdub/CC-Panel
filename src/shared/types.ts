/**
 * The API contract, shared between the server and the Phase 2 client.
 *
 * Response shapes only. Nothing here carries a secret except the three payloads
 * that exist to disclose one exactly once — enrolment, recovery codes, and a
 * deliberate secret reveal — and each is named so that is obvious at the call
 * site.
 */

/**
 * The two languages the panel has dictionaries for.
 *
 * Declared here rather than in the client, because three places need to agree on it: the
 * client's `t()`, the `users.locale` column the API writes, and the notification transport —
 * which is the panel's one sanctioned server-side locale, since a Telegram message has no
 * client to translate it.
 */
export type Locale = 'en' | 'fa';

/** Where a login has got to. */
export type LoginStage =
  /** Password accepted; two-factor is not enrolled yet, so enrolment is next. */
  | 'setup'
  /** Password accepted; a code from the enrolled authenticator is next. */
  | 'totp'
  /** Both factors accepted. */
  | 'authenticated';

export interface LoginResponse {
  stage: Exclude<LoginStage, 'authenticated'>;
}

export interface TotpStepResponse {
  stage: 'authenticated';
  /** Present when a recovery code was spent rather than a TOTP code. */
  usedRecoveryCode?: boolean;
  /** How many unused recovery codes are left. */
  recoveryCodesRemaining: number;
}

export interface SessionSummary {
  id: number;
  authLevel: 'pre' | 'full';
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  absoluteExpiresAt: string | null;
  /** Display only. Nothing in the authentication path decides anything from it. */
  ip: string | null;
  /** Display only. */
  userAgent: string | null;
  /** True for the session making the request. */
  current: boolean;
}

export interface MeResponse {
  username: string;
  stage: LoginStage;
  totpEnabled: boolean;
  stepUpActive: boolean;
  stepUpUntil: string | null;
  recoveryCodesRemaining: number;
  /**
   * The stored interface language, or null when the operator has never chosen one.
   *
   * **Null is not `'en'`.** It means the `Accept-Language` guess `bootstrap.js` made is
   * still in force. The client caches a non-null value in `localStorage`, which is what the
   * next boot applies before first paint — so the panel has at most one wrong-direction
   * frame, on a brand-new browser profile, ever.
   */
  locale: 'en' | 'fa' | null;
  session: SessionSummary;
}

/** `PATCH /api/settings/locale`. */
export interface LocaleResponse {
  locale: 'en' | 'fa';
}

/** Contains the TOTP secret. Returned once, at enrolment. */
export interface EnrollmentResponse {
  secret: string;
  otpauthUri: string;
  algorithm: 'sha1';
  digits: 6;
  periodSeconds: 30;
}

/** Contains the recovery codes in plaintext. Returned once, at generation. */
export interface RecoveryCodesResponse {
  recoveryCodes: string[];
}

export interface EnrollmentVerifiedResponse extends RecoveryCodesResponse {
  stage: 'authenticated';
}

export interface StepUpResponse {
  stepUpUntil: string;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
}

export interface RevokedResponse {
  revoked: number;
}

export interface SecretMetadataResponse {
  secrets: {
    id: number;
    scope: string;
    name: string;
    createdAt: string;
    updatedAt: string;
  }[];
}

/** Contains a stored secret in plaintext. Step-up gated. */
export interface SecretRevealResponse {
  scope: string;
  name: string;
  value: string;
}

export interface BasePathRegeneratedResponse {
  basePath: string;
  /** The prefix and its pre-routing gate are fixed at boot; a restart applies it. */
  restartRequired: true;
}

export interface PasswordChangedResponse {
  ok: true;
  /**
   * Other sessions killed by the change. Reported so the operator can see that a
   * session they did not recognise is now gone.
   */
  revokedSessions: number;
}

export interface AuditEntryView {
  id: number;
  ts: string;
  event: string;
  outcome: string;
  /** Display only, recorded from attacker-controllable input. Never decided from. */
  actorIp: string | null;
  userAgent: string | null;
  meta: Record<string, string | number | boolean | null>;
}

export interface AuditPageResponse {
  entries: AuditEntryView[];
  /** Pass back as `?cursor=` for the next page. Null on the last page. */
  nextCursor: number | null;
}

/** The tamper-evidence report. `ok: false` means the chain does not verify. */
export interface AuditVerifyResponse {
  ok: boolean;
  checked: number;
  head: string;
  floor: string;
  floorId: number;
  reason: string | null;
  brokenAtId: number | null;
  /**
   * `'wrong_key_or_genesis'` when the break is at the oldest surviving row, which
   * is far more likely a wrong `PANEL_MASTER_KEY` than a tamper. Null otherwise.
   */
  hint: string | null;
}

/**
 * `GET /api/metrics`.
 *
 * Structurally identical to the server's `MetricsSnapshot`, and re-exported through
 * the shared module rather than imported from the service, so the client never pulls a
 * server file (and its `node:fs` imports) into the bundle.
 *
 * **Raw numbers and nulls.** Every `null` here means something specific and none of
 * them mean zero: `memory.limitBytes` null is *no limit*, `cpu.percentOfQuota` null is
 * *not computable yet* (a rate needs two samples) or *no quota to be a percentage of*,
 * and `cpu.quotaCores` null is *unknown*. The client formats; the server does not,
 * because a formatted quantity is a translated string.
 */

/**
 * Why a threshold rule is not armed. **Codes, never prose.**
 *
 * Every string the client displays comes from a closed set like this one, because the
 * interface is translated client-side: `"memory.max is the literal max"` in a JSON body
 * is a sentence that can only ever be English. The panel has exactly one sanctioned
 * server-side locale and it is the notification transport, which has no client.
 *
 * - `disabled`     — `PANEL_WATCHDOG_ENABLED` is off. Nothing is sampled and the run
 *                    marker is not written either; one switch, one meaning.
 * - `no_limit`     — the cgroup exists and its `memory.max` is the literal `max`. There
 *                    is no denominator, so a percentage is undefined rather than small.
 * - `unavailable`  — the file is absent or unparseable, which is **not** the same as
 *                    unlimited and must not render as one.
 */
export type WatchdogDisarmedReason = 'disabled' | 'no_limit' | 'unavailable';

/** One threshold rule, as the widget reads it. */
export interface WatchdogRuleStatus {
  /** False means *disabled*, not *healthy*. A rule with no denominator alerts on nothing. */
  armed: boolean;
  /** Null exactly when `armed` is true. */
  reason: WatchdogDisarmedReason | null;
  thresholdPercent: number;
  /** Derived, ten points below `thresholdPercent`, and deliberately not configurable. */
  clearPercent: number;
  state: 'below' | 'above';
  /** The last observed fraction as a percentage, or null when there was nothing to divide. */
  percent: number | null;
  /** When the operator was told. Cleared by a recovery. */
  alertedAt: string | null;
  /**
   * When the current continuous run at or below `clearPercent` began, or null.
   *
   * This is the recovery debounce, and it is the field that makes the invariant
   * checkable from outside: while it is non-null the rule is still `above` and the
   * operator's last message still describes the rule correctly.
   */
  clearingSince: string | null;
}

/**
 * `GET /api/metrics` -> `watchdog`.
 *
 * **Folded into the metrics response rather than given a route of its own.** Same
 * session requirement, same poll, no new line in the route table, and — the reason that
 * decided it — the widget can say *memory alerts are off because this container reports
 * no limit* instead of showing a gauge that silently means nothing. A separate endpoint
 * would have been a second response shape for the client to learn and a second poll to
 * budget.
 */
export interface WatchdogBlock {
  /** `PANEL_WATCHDOG_ENABLED`. */
  enabled: boolean;
  /** Whether the 30 s timer is actually armed. Distinct from `enabled`: tests do not arm it. */
  running: boolean;
  cadenceMs: number;
  /** How long a reading must stay at or below the clear line before a recovery is sent. */
  clearWindowMs: number;
  sampledAt: string | null;
  source: 'cgroup2' | 'os' | null;
  memory: WatchdogRuleStatus;
  disk: WatchdogRuleStatus;
  /**
   * The OOM counter. `baseline` false means no reading has ever been stored, so the
   * next sample adopts the counter instead of announcing every kill that predates this
   * build — which is why `kills: null` is not `kills: 0`.
   */
  oom: { kills: number | null; baseline: boolean };
  cpuPercentOfQuota: number | null;
  /**
   * The wall-clock window this watcher's CPU figure was computed over.
   *
   * Reported so the two consumers of `resources.service.ts` stay distinguishable by
   * evidence from outside the process: this is the watchdog's cadence and `cpu.
   * sampleWindowMs` above is the sampler's, and a shared previous-sample slot would show
   * up here as one of them carrying the other's interval.
   */
  cpuSampleWindowMs: number | null;
  /**
   * What the marker in `/data/run` said at boot.
   *
   * `checked` is false when the watchdog is disabled — nothing looked, which is a
   * different fact from a clean shutdown and must not be spelled the same.
   */
  previousRun: {
    checked: boolean;
    cleanShutdown: boolean | null;
    detail: {
      startedAt: string | null;
      lastSeenAt: string | null;
      ranForSeconds: number | null;
      usedBytes: number | null;
      limitBytes: number | null;
      /** A marker that was there and could not be parsed. Still an unclean restart. */
      markerUnreadable: boolean;
    } | null;
  };
}

export interface ResourceSnapshot {
  memory: {
    usedBytes: number;
    limitBytes: number | null;
    source: 'cgroup2' | 'os';
  };
  cpu: {
    percentOfQuota: number | null;
    quotaCores: number | null;
    usageUsec: number | null;
    sampleWindowMs: number | null;
  };
  disk: {
    path: string;
    usedBytes: number;
    totalBytes: number;
    availableBytes: number;
    databaseBytes: number;
  };
  meta: {
    source: 'cgroup2' | 'os';
    containerized: boolean;
    sampledAt: string;
    cadenceMs: number;
  };
  /** Phase 3. Absent until the panel spawns the processes it would have to measure. */
  perProject?: readonly {
    projectId: string;
    memoryBytes: number;
    cpuPercent: number | null;
    approximate: true;
  }[];
}

/**
 * `GET /api/metrics` — the wire shape, which is the sampler's snapshot **plus** the
 * watchdog's own view.
 *
 * Two producers, joined in the route and nowhere else. `ResourceSampler` does not know
 * the watchdog exists and the watchdog does not know the endpoint exists: they read the
 * same pure functions and share no state, and the response shape is the one place their
 * outputs meet. That is why this is an intersection and not a field on the snapshot —
 * a `watchdog` key inside `MetricsSnapshot` would be a slot the sampler had to fill.
 */
export interface MetricsResponse extends ResourceSnapshot {
  /**
   * The always-on watcher's own view, for the widget.
   *
   * Present on every response, including when the watchdog is switched off: a rule that
   * alerts on nothing is a fact the operator has to be able to see, not an absent key.
   */
  watchdog: WatchdogBlock;
}

/**
 * `GET /api/notifications/telegram`.
 *
 * **Neither credential appears here in any form, not even a masked one.** `mask()` keeps
 * the last four characters, which is harmless for a 46-character bot token and is not
 * harmless for a nine-digit chat id — four digits of a stable identifier for the
 * operator's Telegram account, in a response that can be read again and again. Set or
 * not set, and a length, which is what `npm run preflight` reports for every credential
 * and for the same reason: it catches a truncated paste and a variable that never
 * arrived, and reveals nothing else.
 */
export interface NotificationStatusResponse {
  configured: boolean;
  botToken: { set: boolean; length: number | null };
  chatId: { set: boolean; length: number | null };
  /** Whether a message may end with a deep link carrying the base path. */
  includeLinks: boolean;
  locale: 'en' | 'fa';
  queue: { pending: number; sending: number; sent: number; abandoned: number };
  /** Events refused because the queue was full, since it last drained. */
  dropped: { count: number; since: string | null };
  lastSuccessAt: string | null;
  /** A category and a time. Never Telegram's own text, which echoes what was sent. */
  lastFailure: { at: string; category: string } | null;
}

/** `POST /api/notifications/test` — `202`, because delivery is never synchronous. */
export interface NotificationQueuedResponse {
  queued: number;
}

/** `GET /api/notifications/queue/:id`. */
export interface NotificationQueueRowResponse {
  id: number;
  kind: 'turn_complete' | 'resource_alert' | 'security_alert' | 'test';
  state: 'pending' | 'sending' | 'sent' | 'abandoned';
  attempts: number;
  createdAt: string;
  nextAttemptAt: string;
  lastError: string | null;
  sentAt: string | null;
}

/** Every error response in the application. Nothing else is ever returned. */
export interface ErrorResponse {
  error: string;
}
