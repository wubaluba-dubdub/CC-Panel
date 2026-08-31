import type { Database } from 'better-sqlite3';
import { getDb } from '../db.js';
import { SecretString } from '../crypto.js';
import { containsRedactableSecret, createBasePathElider } from '../plugins/logger-redaction.js';
import { type Clock, isoNow, systemClock } from '../utils/clock.js';

/**
 * The audit event vocabulary.
 *
 * Fixed strings, not free text, so a query in M1.5 can filter on them and a typo
 * cannot invent a new event type that nothing knows how to display.
 */
export const AuditEvent = {
  SetupCompleted: 'setup.completed',
  TwoFactorEnrollmentStarted: 'two_factor.enrollment_started',
  LoginSuccess: 'login.success',
  LoginFailure: 'login.failure',
  TotpFailure: 'totp.failure',
  RecoveryCodeUsed: 'recovery_code.used',
  DelayApplied: 'auth.delay_applied',
  SessionCreated: 'session.created',
  SessionRevoked: 'session.revoked',
  PasswordChanged: 'password.changed',
  StepUpGranted: 'stepup.granted',
  TwoFactorDisabled: 'two_factor.disabled',
  RecoveryCodesRegenerated: 'recovery_codes.regenerated',
  SecretRevealed: 'secret.revealed',
  SecretChanged: 'secret.changed',
  BasePathRegenerated: 'base_path.regenerated',
} as const;

export type AuditEventName = (typeof AuditEvent)[keyof typeof AuditEvent];

export type AuditOutcome = 'success' | 'failure';

/**
 * Why a login failed, as a category.
 *
 * Never the attempted username, never the attempted password, never which of the
 * two was wrong at a level of detail the response does not already reveal. The
 * operator needs to know "someone is guessing"; they do not need the guesses.
 */
export const FailureReason = {
  BadCredentials: 'bad_credentials',
  BadTotpCode: 'bad_totp_code',
  BadRecoveryCode: 'bad_recovery_code',
  ReplayedTotpCode: 'replayed_totp_code',
  NoPendingLogin: 'no_pending_login',
  TwoFactorNotEnrolled: 'two_factor_not_enrolled',
} as const;

export type FailureReasonName = (typeof FailureReason)[keyof typeof FailureReason];

/** Only primitives. An object value is how a `SecretString` sneaks in nested. */
export type AuditMetaValue = string | number | boolean | null;
export type AuditMeta = Readonly<Record<string, AuditMetaValue>>;

export interface AuditEntry {
  readonly event: AuditEventName;
  readonly outcome: AuditOutcome;
  readonly actorIp?: string | null;
  readonly userAgent?: string | null;
  readonly meta?: AuditMeta;
}

export interface AuditRecord {
  id: number;
  ts: string;
  event: string;
  actorIp: string | null;
  userAgent: string | null;
  outcome: string;
  meta: Record<string, AuditMetaValue>;
}

/**
 * Thrown when a caller tries to put something into audit metadata that must not
 * be persisted.
 *
 * This throws rather than scrubbing and continuing. Metadata is built from fixed
 * shapes by this application's own code, so a violation is a programming error,
 * and the loud version of a programming error is the one that gets fixed. The
 * append-only audit log is not the place to discover, months later, that a
 * credential has been sitting in it.
 */
export class AuditMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditMetaError';
  }
}

interface AuditRow {
  id: number;
  ts: string;
  event: string;
  actor_ip: string | null;
  user_agent: string | null;
  outcome: string;
  meta_json: string;
}

export class AuditService {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #elideBasePath: (text: string) => string;

  constructor(opts: { db?: Database; clock?: Clock; basePath?: string } = {}) {
    this.#db = opts.db ?? getDb();
    this.#clock = opts.clock ?? systemClock;
    this.#elideBasePath =
      opts.basePath === undefined ? (text) => text : createBasePathElider(opts.basePath);
  }

  /**
   * Validates and normalises metadata.
   *
   * Typed `unknown` internally even though {@link AuditMeta} already restricts
   * callers to primitives: the compile-time type is the first line and this is the
   * second, and the second has to hold for a value that arrived through an `any`,
   * a cast, or a JSON parse.
   *
   * Three checks, in order of how badly each would fail: a `SecretString` (the
   * caller passed a secret object and its `toJSON` would have written
   * `[redacted]`, which is harmless but means the call site is confused); a
   * non-primitive (which is how something with a `toJSON` gets nested past the
   * first check); and finally the credential-shape scan, which is the one that
   * catches a genuine token pasted in as a plain string.
   */
  #normaliseMeta(meta: Readonly<Record<string, unknown>>): Record<string, AuditMetaValue> {
    const out: Record<string, AuditMetaValue> = {};

    for (const [key, value] of Object.entries(meta)) {
      if (value instanceof SecretString) {
        throw new AuditMetaError(`audit meta ${JSON.stringify(key)} is a SecretString`);
      }
      const primitive =
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean';
      if (!primitive) {
        throw new AuditMetaError(
          `audit meta ${JSON.stringify(key)} must be a string, number, boolean or null`,
        );
      }
      out[key] = typeof value === 'string' ? this.#elideBasePath(value) : value;
    }

    const json = JSON.stringify(out);
    if (containsRedactableSecret(json)) {
      throw new AuditMetaError('audit meta contains something shaped like a credential');
    }

    return out;
  }

  write(entry: AuditEntry): void {
    const meta = this.#normaliseMeta(entry.meta ?? {});

    this.#db
      .prepare(
        `INSERT INTO audit_log (ts, event, actor_ip, user_agent, outcome, meta_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        isoNow(this.#clock),
        entry.event,
        entry.actorIp ?? null,
        entry.userAgent ?? null,
        entry.outcome,
        JSON.stringify(meta),
      );
  }

  /** Newest first. The paginated query API proper is M1.5. */
  recent(limit = 50): AuditRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(limit) as AuditRow[];

    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      event: row.event,
      actorIp: row.actor_ip,
      userAgent: row.user_agent,
      outcome: row.outcome,
      meta: JSON.parse(row.meta_json) as Record<string, AuditMetaValue>,
    }));
  }
}
