import type { Database } from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../db.js';
import { type Clock, isoFrom, msFromIso, systemClock } from '../utils/clock.js';
import { timingSafeEqualStrings } from '../utils/timing-safe.js';

/**
 * The session cookie name.
 *
 * The `__Secure-` prefix makes the browser refuse the cookie unless it carries
 * `Secure` and arrives over a secure channel, which turns an accidentally
 * dropped `Secure` attribute into an immediate, visible failure instead of a
 * silent downgrade. `__Host-` would be stronger still, but it requires `Path=/`
 * and this panel's cookie is scoped to `/${basePath}`.
 */
export const SESSION_COOKIE = '__Secure-panel_session';

/** Sliding. Every authenticated request pushes it out. */
export const IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000;

/** Not sliding. A session dies 30 days after it became a full session, full stop. */
export const ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long the gap between the password step and the second-factor step may be.
 * Short on purpose: a 'pre' session is a password that has been accepted and not
 * yet paid for, and it lives in a cookie.
 */
export const PRE_AUTH_LIFETIME_MS = 5 * 60 * 1000;

/** How long a step-up stays valid, on the one session that earned it. */
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

/** Bytes of entropy in a session token. 256 bits, from the CSPRNG. */
export const SESSION_TOKEN_BYTES = 32;

/**
 * 'pre' has passed the password step only. It can reach the second-factor and
 * enrolment endpoints and nothing else. 'full' has passed both factors.
 */
export type AuthLevel = 'pre' | 'full';

export interface SessionRecord {
  id: number;
  authLevel: AuthLevel;
  createdAt: string;
  lastSeenAt: string;
  /** Idle deadline. Slides on use. */
  expiresAt: string;
  /** Absolute deadline. Never moves. */
  absoluteExpiresAt: string | null;
  /** Display-only. Nothing decides anything from this. */
  ip: string | null;
  /** Display-only. */
  userAgent: string | null;
  stepUpUntil: string | null;
}

interface SessionRow {
  id: number;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
  step_up_until: string | null;
  absolute_expires_at: string | null;
  auth_level: string;
}

/**
 * Only the hash is stored. A stolen database therefore yields no usable session
 * cookie, and there is no key to lose — unlike encrypting the token, a hash has
 * nothing to recover it with.
 *
 * SHA-256 with no salt and no stretching is correct here, unlike for a password:
 * the input is 256 bits of CSPRNG output, so there is nothing to guess and
 * nothing to look up in a table.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    authLevel: row.auth_level === 'pre' ? 'pre' : 'full',
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    ip: row.ip,
    userAgent: row.user_agent,
    stepUpUntil: row.step_up_until,
  };
}

export interface CreatedSession {
  /** The plaintext token. Exists here and in the cookie, nowhere else, ever. */
  token: string;
  session: SessionRecord;
}

export class SessionService {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(opts: { db?: Database; clock?: Clock } = {}) {
    this.#db = opts.db ?? getDb();
    this.#clock = opts.clock ?? systemClock;
  }

  #newToken(): { token: string; tokenHash: string } {
    // base64url so the value is cookie-safe with no encoding step to get wrong.
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    return { token, tokenHash: hashToken(token) };
  }

  create(opts: {
    authLevel: AuthLevel;
    ip?: string | null;
    userAgent?: string | null;
  }): CreatedSession {
    const now = this.#clock.now();
    const { token, tokenHash } = this.#newToken();

    const idleMs = opts.authLevel === 'pre' ? PRE_AUTH_LIFETIME_MS : IDLE_TIMEOUT_MS;
    const absoluteMs = opts.authLevel === 'pre' ? PRE_AUTH_LIFETIME_MS : ABSOLUTE_LIFETIME_MS;

    const info = this.#db
      .prepare(
        `INSERT INTO sessions
           (token_hash, created_at, last_seen_at, expires_at, absolute_expires_at,
            ip, user_agent, step_up_until, auth_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        tokenHash,
        isoFrom(now),
        isoFrom(now),
        isoFrom(now + idleMs),
        isoFrom(now + absoluteMs),
        opts.ip ?? null,
        opts.userAgent ?? null,
        opts.authLevel,
      );

    const session = this.#byId(Number(info.lastInsertRowid));
    if (session === null) throw new Error('session insert did not produce a row');
    return { token, session };
  }

  #byId(id: number): SessionRecord | null {
    const row = this.#db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    return row ? toRecord(row) : null;
  }

  /**
   * Resolves a cookie value to a live session, or `null`.
   *
   * The lookup scans every row and compares each stored hash with
   * `timingSafeEqual` rather than letting SQLite match on an indexed `=`. There
   * are at most a handful of sessions for a single user, so the scan is free, and
   * it means no comparison against a stored credential anywhere in this codebase
   * short-circuits on the first differing byte. The loop deliberately does not
   * break early.
   *
   * A session past either deadline is deleted here rather than merely rejected,
   * so the table does not accumulate dead rows waiting for a sweeper that would
   * be the only thing keeping this honest.
   */
  resolve(token: string): SessionRecord | null {
    const wanted = hashToken(token);
    const rows = this.#db.prepare('SELECT * FROM sessions').all() as SessionRow[];

    let match: SessionRow | null = null;
    for (const row of rows) {
      if (timingSafeEqualStrings(row.token_hash, wanted)) match = row;
    }
    if (match === null) return null;

    const now = this.#clock.now();
    const idleDeadline = msFromIso(match.expires_at);
    const absoluteDeadline = msFromIso(match.absolute_expires_at);

    // A NaN deadline (missing or unparseable) counts as expired. Failing closed
    // is the only safe direction for a deadline you cannot read.
    const expired =
      !(now < idleDeadline) || !(now < absoluteDeadline);

    if (expired) {
      this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(match.id);
      return null;
    }

    // Slide the idle deadline. A 'pre' session does not slide: its five minutes
    // are five minutes from the password step, not five minutes of inactivity.
    if (match.auth_level === 'full') {
      const slid = Math.min(now + IDLE_TIMEOUT_MS, absoluteDeadline);
      this.#db
        .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
        .run(isoFrom(now), isoFrom(slid), match.id);
    } else {
      this.#db
        .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
        .run(isoFrom(now), match.id);
    }

    const refreshed = this.#byId(match.id);
    return refreshed;
  }

  /**
   * Issues a new token for an existing session, returning it.
   *
   * Called on every privilege change: the second factor being accepted, and a
   * password change. The row keeps its identity so `revoke-others` and the
   * session list stay coherent across a rotation, but the old cookie value stops
   * working the instant this returns.
   *
   * Promoting to 'full' restarts the absolute lifetime and drops any step-up:
   * thirty days should be counted from the point both factors were satisfied, and
   * a step-up granted at a lower privilege level must not survive the promotion.
   */
  rotate(id: number, opts: { toLevel?: AuthLevel } = {}): string {
    const existing = this.#byId(id);
    if (existing === null) throw new Error(`no session ${id}`);

    const now = this.#clock.now();
    const { token, tokenHash } = this.#newToken();
    const promoting = opts.toLevel !== undefined && opts.toLevel !== existing.authLevel;
    const level = opts.toLevel ?? existing.authLevel;

    const idleMs = level === 'pre' ? PRE_AUTH_LIFETIME_MS : IDLE_TIMEOUT_MS;

    if (promoting) {
      this.#db
        .prepare(
          `UPDATE sessions
              SET token_hash = ?, auth_level = ?, created_at = ?, last_seen_at = ?,
                  expires_at = ?, absolute_expires_at = ?, step_up_until = NULL
            WHERE id = ?`,
        )
        .run(
          tokenHash,
          level,
          isoFrom(now),
          isoFrom(now),
          isoFrom(now + idleMs),
          isoFrom(now + (level === 'pre' ? PRE_AUTH_LIFETIME_MS : ABSOLUTE_LIFETIME_MS)),
          id,
        );
    } else {
      const absolute = msFromIso(existing.absoluteExpiresAt);
      const slid = Number.isNaN(absolute) ? now + idleMs : Math.min(now + idleMs, absolute);
      this.#db
        .prepare(
          `UPDATE sessions SET token_hash = ?, last_seen_at = ?, expires_at = ? WHERE id = ?`,
        )
        .run(tokenHash, isoFrom(now), isoFrom(slid), id);
    }

    return token;
  }

  grantStepUp(id: number): string {
    const until = isoFrom(this.#clock.now() + STEP_UP_WINDOW_MS);
    this.#db.prepare('UPDATE sessions SET step_up_until = ? WHERE id = ?').run(until, id);
    return until;
  }

  clearStepUp(id: number): void {
    this.#db.prepare('UPDATE sessions SET step_up_until = NULL WHERE id = ?').run(id);
  }

  hasStepUp(session: SessionRecord): boolean {
    if (session.authLevel !== 'full') return false;
    const until = msFromIso(session.stepUpUntil);
    return this.#clock.now() < until;
  }

  revoke(id: number): boolean {
    return this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
  }

  /** Returns how many were removed. */
  revokeOthers(keepId: number): number {
    return this.#db.prepare('DELETE FROM sessions WHERE id != ?').run(keepId).changes;
  }

  revokeAll(): number {
    return this.#db.prepare('DELETE FROM sessions').run().changes;
  }

  list(): SessionRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM sessions ORDER BY created_at DESC, id DESC')
      .all() as SessionRow[];
    return rows.map(toRecord);
  }

  /** Housekeeping. `resolve()` already removes the row it walks past. */
  purgeExpired(): number {
    const now = isoFrom(this.#clock.now());
    return this.#db
      .prepare(
        'DELETE FROM sessions WHERE expires_at <= ? OR absolute_expires_at IS NULL OR absolute_expires_at <= ?',
      )
      .run(now, now).changes;
  }
}
