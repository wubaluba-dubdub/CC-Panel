/**
 * The API contract, shared between the server and the Phase 2 client.
 *
 * Response shapes only. Nothing here carries a secret except the three payloads
 * that exist to disclose one exactly once — enrolment, recovery codes, and a
 * deliberate secret reveal — and each is named so that is obvious at the call
 * site.
 */

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
  session: SessionSummary;
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
export interface MetricsResponse {
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

/** Every error response in the application. Nothing else is ever returned. */
export interface ErrorResponse {
  error: string;
}
