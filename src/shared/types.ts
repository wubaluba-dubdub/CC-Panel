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

/**
 * The machine-readable half of an error, from a **closed set**.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 *
 * `app.setErrorHandler` sends only the status's standard reason phrase, and that is
 * deliberate after two credential leaks came out of error bodies (`docs/SECURITY.md`
 * §*Generic error responses*). But it leaves the client unable to tell *step-up required*
 * from any other 403, and R3 makes the phrase itself unusable: the interface is translated
 * client-side, so `"Forbidden"` is a string that can only ever be English. Without a code the
 * client guesses from status codes until somebody is tempted to put prose in the body.
 *
 * ── The rule every member obeys ─────────────────────────────────────────────
 *
 * **A code discloses nothing the status and the reason phrase do not already disclose.**
 * Two consequences that are not obvious:
 *
 * - **Every authentication rejection is `bad_credentials`.** An unknown username, a wrong
 *   password, a wrong TOTP code, a *replayed* TOTP code and a spent recovery code all answer
 *   with the same code, because the fixed-dummy-hash path exists precisely so those cases are
 *   indistinguishable — and `replayed_code` would say "that code was valid and already used",
 *   which is a fact about the panel's state. The audit log keeps the categories; the client
 *   does not get them.
 * - **`step_up_required` is safe** because the caller already holds a full session and knows
 *   perfectly well whether it has stepped up. `auth_in_progress` is safe because the
 *   single-flight gate rejects before any credential is read.
 *
 * Never a message, never a variable, never a value. `tests/integration/error-codes.test.ts`
 * asserts the set is closed and that no code carries free text.
 */
export type ErrorCode =
  /** No live session, or one at the wrong level. Always 401. */
  | 'unauthenticated'
  /** Credentials were not accepted. Always 401, and never says which half was wrong. */
  | 'bad_credentials'
  /** A full session that has not stepped up in the last five minutes. Always 403. */
  | 'step_up_required'
  /** The double-submit token was missing or did not match. Always 403. */
  | 'csrf_invalid'
  /** `Origin`/`Host` validation, or any other refusal. Always 403. */
  | 'forbidden'
  /** A token bucket is empty. 429 with `Retry-After`. */
  | 'rate_limited'
  /** The single-flight gate: one attempt runs at a time. 429, and not a failure. */
  | 'auth_in_progress'
  /** The new password is too weak or too common. 400. */
  | 'weak_password'
  /** The body did not parse or did not validate. 400. */
  | 'bad_request'
  | 'not_found'
  /** The panel's state does not permit it — 2FA already off, base path pinned by the env. */
  | 'conflict'
  | 'too_large'
  | 'server_error';

/**
 * The same set, at runtime, so the error handler can **refuse anything else**.
 *
 * Not a convenience. Fastify's own errors carry a `code` — `FST_ERR_CTP_BODY_TOO_LARGE` for a
 * body over `bodyLimit`, and one per internal failure — and an error handler that forwarded
 * `err.code` unchecked would put a library's identifier, and whatever a future library chooses
 * to put there, straight into a response body. That is the same shape as the two credential
 * leaks that came out of error messages, and it is closed the same way: the response can only
 * ever contain a value from this list.
 *
 * `satisfies` ties the two together — a code added to the union and not here, or here and not
 * in the union, does not compile.
 */
export const ERROR_CODES = [
  'unauthenticated',
  'bad_credentials',
  'step_up_required',
  'csrf_invalid',
  'forbidden',
  'rate_limited',
  'auth_in_progress',
  'weak_password',
  'bad_request',
  'not_found',
  'conflict',
  'too_large',
  'server_error',
] as const satisfies readonly ErrorCode[];

/** Whether an unknown value is one of the codes the panel is allowed to send. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** Every error response in the application. Nothing else is ever returned. */
export interface ErrorResponse {
  /** The status's standard reason phrase, and nothing else. Not for display. */
  error: string;
  /** What the client should say about it. See {@link ErrorCode}. */
  code: ErrorCode;
}
