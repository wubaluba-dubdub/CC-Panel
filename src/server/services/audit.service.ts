import { createHmac } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { getDb } from '../db.js';
import { KeyPurpose, SecretString, deriveSubkey } from '../crypto.js';
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
  /**
   * Written by retention, immediately before it deletes anything, so the deletion
   * is itself part of the record. A gap in the ids with no checkpoint row above it
   * is evidence of tampering rather than housekeeping.
   */
  AuditTrimmed: 'audit.trimmed',
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

interface ChainedAuditRow extends AuditRow {
  prev_hash: string | null;
  row_hash: string | null;
}

/** What the chain points back to before anything has been written or trimmed. */
const GENESIS = 'genesis';

/** How the chain is broken, when it is. */
export type AuditChainBreak =
  | 'unchained_row'
  | 'prev_hash_mismatch'
  | 'row_hash_mismatch'
  | 'head_mismatch';

export interface AuditVerification {
  ok: boolean;
  /** Rows walked. */
  checked: number;
  /** The stored anchor: the hash the newest row is expected to have. */
  head: string;
  /** The hash the oldest surviving row must point back to. */
  floor: string;
  /** Ids at or below this were removed by retention, not by an attacker. */
  floorId: number;
  reason: AuditChainBreak | null;
  /** The first row that failed, or the newest row for a head mismatch. */
  brokenAtId: number | null;
}

export interface AuditQuery {
  /** 1..200. */
  limit?: number | undefined;
  /** Return rows with an id strictly below this. Newest-first paging. */
  cursor?: number | null | undefined;
  /** Restrict to these event names. Empty or absent means all. */
  events?: readonly string[] | undefined;
  /** Inclusive ISO-8601 bounds on `ts`, which sorts lexicographically. */
  from?: string | null | undefined;
  to?: string | null | undefined;
}

export interface AuditPage {
  entries: AuditRecord[];
  /** Pass back as `cursor`. Null when this was the last page. */
  nextCursor: number | null;
}

interface ChainState {
  anchorHash: string;
  floorHash: string;
  floorId: number;
}

/**
 * The exact bytes a row's hash is computed over.
 *
 * An array, not an object, so nothing depends on key order, and every column that
 * carries meaning is in it — including `id`, which is what makes a content swap
 * between two rows detectable: each row's hash is bound to the id it sits at.
 * `meta_json` goes in as the stored string rather than a re-serialisation of the
 * parsed object, so a whitespace edit inside it is a break too.
 */
function canonicalRow(row: AuditRow): string {
  return JSON.stringify([
    row.id,
    row.ts,
    row.event,
    row.actor_ip,
    row.user_agent,
    row.outcome,
    row.meta_json,
  ]);
}

/**
 * HMAC-SHA256 over the previous hash and this row's canonical form.
 *
 * Keyed with an HKDF subkey under {@link KeyPurpose.AuditChain}, so an attacker who
 * has the database file and can drop both triggers still cannot produce a hash that
 * verifies. The separator cannot appear in a hex digest, so the two inputs cannot
 * be shifted across the boundary.
 */
function chainHash(prevHash: string, canonical: string): string {
  return createHmac('sha256', deriveSubkey(KeyPurpose.AuditChain))
    .update(prevHash, 'utf8')
    .update('\n', 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
}

/** Row cap before retention trims the oldest entries. */
export const DEFAULT_MAX_AUDIT_ROWS = 20_000;

export interface AuditServiceOptions {
  db?: Database;
  clock?: Clock;
  basePath?: string;
  /** Retention cap. Must be at least 2: one checkpoint plus one real row. */
  maxRows?: number;
  /** Writes between retention checks. Keeps `COUNT(*)` off the hot path. */
  trimCheckEvery?: number;
}

export class AuditService {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #elideBasePath: (text: string) => string;
  readonly #maxRows: number;
  readonly #trimCheckEvery: number;
  #sinceTrimCheck: number;

  constructor(opts: AuditServiceOptions = {}) {
    this.#db = opts.db ?? getDb();
    this.#clock = opts.clock ?? systemClock;
    this.#elideBasePath =
      opts.basePath === undefined ? (text) => text : createBasePathElider(opts.basePath);
    this.#maxRows = Math.max(2, opts.maxRows ?? DEFAULT_MAX_AUDIT_ROWS);
    this.#trimCheckEvery = Math.max(1, opts.trimCheckEvery ?? 64);
    // Check on the first write of the process, so a cap lowered by configuration
    // takes effect at boot rather than after another 64 events.
    this.#sinceTrimCheck = this.#trimCheckEvery;
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

  #state(): ChainState {
    const row = this.#db
      .prepare('SELECT anchor_hash, floor_hash, floor_id FROM audit_chain WHERE id = 1')
      .get() as { anchor_hash: string; floor_hash: string; floor_id: number } | undefined;
    if (row === undefined) throw new Error('audit_chain row is missing');
    return { anchorHash: row.anchor_hash, floorHash: row.floor_hash, floorId: row.floor_id };
  }

  /**
   * Appends one row and extends the chain, atomically.
   *
   * The insert has to happen before the hash can be computed, because the hash
   * covers the row's own AUTOINCREMENT id — so the row lands with `row_hash NULL`
   * and is updated once, inside the same transaction. That single UPDATE is legal
   * only because the trigger is gated on `OLD.row_hash IS NOT NULL`; the row is
   * immutable from the moment it is chained. If anything here throws, the
   * transaction rolls back and the chain is left exactly as it was — never a row
   * with no hash, never an anchor pointing at a row that does not exist.
   */
  #append(row: Omit<AuditRow, 'id'>): number {
    const insert = this.#db.prepare(
      `INSERT INTO audit_log (ts, event, actor_ip, user_agent, outcome, meta_json, prev_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const setHash = this.#db.prepare('UPDATE audit_log SET row_hash = ? WHERE id = ?');
    const setAnchor = this.#db.prepare(
      'UPDATE audit_chain SET anchor_hash = ?, updated_at = ? WHERE id = 1',
    );

    const txn = this.#db.transaction((): number => {
      const state = this.#state();
      const info = insert.run(
        row.ts,
        row.event,
        row.actor_ip,
        row.user_agent,
        row.outcome,
        row.meta_json,
        state.anchorHash,
      );
      const id = Number(info.lastInsertRowid);
      const hash = chainHash(state.anchorHash, canonicalRow({ ...row, id }));
      setHash.run(hash, id);
      setAnchor.run(hash, isoNow(this.#clock));
      return id;
    });

    return txn();
  }

  write(entry: AuditEntry): void {
    const meta = this.#normaliseMeta(entry.meta ?? {});

    this.#append({
      ts: isoNow(this.#clock),
      event: entry.event,
      actor_ip: entry.actorIp ?? null,
      user_agent: entry.userAgent ?? null,
      outcome: entry.outcome,
      meta_json: JSON.stringify(meta),
    });

    this.#sinceTrimCheck += 1;
    if (this.#sinceTrimCheck >= this.#trimCheckEvery) {
      this.#sinceTrimCheck = 0;
      this.trim();
    }
  }

  /**
   * Chains any row that predates migration 008.
   *
   * Called once at boot. M1.4 wrote rows before the chain existed, and an unchained
   * row makes `verify()` fail for a reason that is not tampering — so they are
   * hashed in id order on first run. This is honest about what it can prove: those
   * rows are attested from *now*, not from when they were written. Rows that already
   * carry a hash are never touched, and the trigger would refuse if this tried.
   */
  initChain(): { backfilled: number } {
    const pending = this.#db
      .prepare('SELECT * FROM audit_log WHERE row_hash IS NULL ORDER BY id ASC')
      .all() as ChainedAuditRow[];
    if (pending.length === 0) return { backfilled: 0 };

    const setHashes = this.#db.prepare(
      'UPDATE audit_log SET prev_hash = ?, row_hash = ? WHERE id = ?',
    );
    const setAnchor = this.#db.prepare(
      'UPDATE audit_chain SET anchor_hash = ?, updated_at = ? WHERE id = 1',
    );

    const txn = this.#db.transaction((): number => {
      let prev = this.#state().anchorHash;
      for (const row of pending) {
        const hash = chainHash(prev, canonicalRow(row));
        setHashes.run(prev, hash, row.id);
        prev = hash;
      }
      setAnchor.run(prev, isoNow(this.#clock));
      return pending.length;
    });

    return { backfilled: txn() };
  }

  /**
   * Walks the whole chain and reports the **first** break.
   *
   * Four distinguishable failures: a row with no hash at all; a row whose
   * `prev_hash` does not match its predecessor's hash (a row was inserted or
   * removed); a row whose own hash does not match its contents (a column was
   * edited, or two rows' contents were swapped, since the hash covers the id); and
   * a head mismatch, where the chain is internally consistent but does not reach
   * the stored anchor — which is what catches truncating the newest rows.
   */
  verify(): AuditVerification {
    const state = this.#state();
    const rows = this.#db
      .prepare('SELECT * FROM audit_log ORDER BY id ASC')
      .all() as ChainedAuditRow[];

    const base: Omit<AuditVerification, 'ok' | 'reason' | 'brokenAtId'> = {
      checked: rows.length,
      head: state.anchorHash,
      floor: state.floorHash,
      floorId: state.floorId,
    };

    let expectedPrev = state.floorHash;
    for (const row of rows) {
      if (row.row_hash === null || row.prev_hash === null) {
        return { ...base, ok: false, reason: 'unchained_row', brokenAtId: row.id };
      }
      if (row.prev_hash !== expectedPrev) {
        return { ...base, ok: false, reason: 'prev_hash_mismatch', brokenAtId: row.id };
      }
      if (chainHash(row.prev_hash, canonicalRow(row)) !== row.row_hash) {
        return { ...base, ok: false, reason: 'row_hash_mismatch', brokenAtId: row.id };
      }
      expectedPrev = row.row_hash;
    }

    if (expectedPrev !== state.anchorHash) {
      return {
        ...base,
        ok: false,
        reason: 'head_mismatch',
        brokenAtId: rows.length === 0 ? null : rows[rows.length - 1]!.id,
      };
    }

    return { ...base, ok: true, reason: null, brokenAtId: null };
  }

  /**
   * Retention: keep at most `maxRows`, oldest first out.
   *
   * A checkpoint row (`audit.trimmed`) is appended **before** anything is deleted,
   * naming how many rows went and the id they went through. So the deletion is
   * inside the chain, and a gap with no checkpoint above it is tampering rather than
   * housekeeping. The floor then moves to the hash of the last row removed, which
   * keeps the surviving chain anchored — verification passes after a legitimate
   * trim and still fails if someone deletes a row by hand, because they cannot
   * move the floor without also writing a checkpoint the chain accepts.
   *
   * The DELETE trigger is unlocked for the width of the transaction and relocked
   * inside it, so a rollback leaves it locked either way.
   */
  trim(): { removed: number; throughId: number | null } {
    const { count } = this.#db.prepare('SELECT COUNT(*) AS count FROM audit_log').get() as {
      count: number;
    };
    if (count <= this.#maxRows) return { removed: 0, throughId: null };

    // One extra, to leave room for the checkpoint the trim itself writes.
    const excess = count - this.#maxRows + 1;
    const doomed = this.#db
      .prepare('SELECT id, row_hash FROM audit_log ORDER BY id ASC LIMIT ?')
      .all(excess) as { id: number; row_hash: string | null }[];
    const last = doomed[doomed.length - 1];
    if (last === undefined) return { removed: 0, throughId: null };

    const unlock = this.#db.prepare('UPDATE audit_chain SET trim_unlocked = ? WHERE id = 1');
    const remove = this.#db.prepare('DELETE FROM audit_log WHERE id <= ?');
    const setFloor = this.#db.prepare(
      'UPDATE audit_chain SET floor_hash = ?, floor_id = ?, updated_at = ? WHERE id = 1',
    );

    // Checkpoint and deletion in one transaction (`#append` nests as a savepoint),
    // so there is never a checkpoint claiming a trim that did not happen, nor a
    // trim with no checkpoint above it.
    const txn = this.#db.transaction((): void => {
      this.#append({
        ts: isoNow(this.#clock),
        event: AuditEvent.AuditTrimmed,
        actor_ip: null,
        user_agent: null,
        outcome: 'success',
        meta_json: JSON.stringify({
          removed: doomed.length,
          throughId: last.id,
          cap: this.#maxRows,
        }),
      });
      unlock.run(1);
      try {
        remove.run(last.id);
        setFloor.run(last.row_hash ?? GENESIS, last.id, isoNow(this.#clock));
      } finally {
        unlock.run(0);
      }
    });
    txn();

    return { removed: doomed.length, throughId: last.id };
  }

  /**
   * Cursor-based, newest first.
   *
   * Paged on the primary key rather than an offset: `LIMIT/OFFSET` over a table
   * that is being appended to shows the same row twice or skips one, because
   * everything shifts by one with every write. `ts` is ISO-8601 with a `Z`, which
   * sorts lexicographically in chronological order, so the range filter is a plain
   * string comparison.
   */
  query(opts: AuditQuery = {}): AuditPage {
    const limit = Math.min(200, Math.max(1, Math.trunc(opts.limit ?? 50)));
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (opts.cursor !== undefined && opts.cursor !== null) {
      where.push('id < ?');
      params.push(opts.cursor);
    }
    if (opts.events !== undefined && opts.events.length > 0) {
      where.push(`event IN (${opts.events.map(() => '?').join(', ')})`);
      params.push(...opts.events);
    }
    if (opts.from !== undefined && opts.from !== null) {
      where.push('ts >= ?');
      params.push(opts.from);
    }
    if (opts.to !== undefined && opts.to !== null) {
      where.push('ts <= ?');
      params.push(opts.to);
    }

    const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
    // One more than asked for: its existence is what says there is a next page,
    // without a second COUNT(*) that would race the next write anyway.
    const rows = this.#db
      .prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit + 1) as AuditRow[];

    const page = rows.slice(0, limit);
    return {
      entries: page.map((row) => this.#toRecord(row)),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  #toRecord(row: AuditRow): AuditRecord {
    return {
      id: row.id,
      ts: row.ts,
      event: row.event,
      actorIp: row.actor_ip,
      userAgent: row.user_agent,
      outcome: row.outcome,
      meta: JSON.parse(row.meta_json) as Record<string, AuditMetaValue>,
    };
  }

  /** Newest first, unfiltered. Thin wrapper over {@link query} for internal callers. */
  recent(limit = 50): AuditRecord[] {
    return this.query({ limit }).entries;
  }
}
