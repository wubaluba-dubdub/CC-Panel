import type { Database } from 'better-sqlite3';
import { getDb } from '../db.js';
import { SecretString } from '../crypto.js';
import { createBasePathElider, redactSecrets } from '../plugins/logger-redaction.js';
import { type Clock, isoFrom, isoNow, systemClock } from '../utils/clock.js';
import {
  AuditEvent,
  type AuditEventName,
  type AuditRecord,
  type AuditService,
} from './audit.service.js';
import { DICTS, isNotifyEvent, mapEventStrings, renderEvent } from './notification-render.js';
import type { NotifyEvent, NotifyEventKind, NotifyLocale } from './notification-render.js';
import { countedEventsFor, ruleFor, type NotifiedAuditEvent } from './notification-rules.js';
import { failureCategory, type NotificationTransport } from './telegram.transport.js';
import type { TimerHandle } from './resources.service.js';

/**
 * The notification queue and its single worker.
 *
 * Four properties this is built around rather than retrofitted:
 *
 * 1. **Enqueue is synchronous and local; sending never is.** {@link NotifyService.notify}
 *    is one `INSERT` inside whatever transaction the caller is already in, and it
 *    returns. No `await` on a socket, no `fetch` in a request handler, no floating
 *    promise. The worst a broken Telegram configuration can do to a request is nothing.
 * 2. **Redaction happens at enqueue, not at send.** The stored event is already through
 *    the secret redaction and the base-path elision, because this table lives on the
 *    volume — redacting at send time would leave the base path sitting in a database
 *    file, which is worse than a log line, not better.
 * 3. **One sender at a time.** In-process by a flag, across processes by claiming a row
 *    with `UPDATE … WHERE id = ? AND state = 'pending'` and checking `changes === 1`.
 *    Delivery is therefore **at-least-once**: a crash between a successful request and
 *    the row update means the message is sent again on the next boot. For a
 *    notification that is the right way round — a duplicate is an annoyance, a lost
 *    security alert is a failure of the whole feature.
 * 4. **The worker is a chain of one-shot timers, armed only when something is due.** No
 *    interval, so an idle panel with an empty queue costs nothing at all.
 */

/** Attempts before a row is a dead letter. ~2 hours of trying at the backoff below. */
export const MAX_ATTEMPTS = 12;
/** First retry after one second, doubling. */
export const BACKOFF_BASE_MS = 1000;
/** Ceiling on the doubling. */
export const BACKOFF_CAP_MS = 15 * 60_000;
/** ±20 %, so a burst enqueued together does not retry in lockstep. */
export const BACKOFF_JITTER = 0.2;
/**
 * How long a row waits when there is no Telegram configuration at all.
 *
 * A fixed short interval **and no attempt consumed**: an unconfigured panel must
 * accumulate its notifications and deliver them when it is configured, so "nobody has
 * set this up yet" cannot be the thing that dead-letters two hours of security alerts.
 */
export const UNCONFIGURED_RETRY_MS = 60_000;
/** Pending rows before new events are refused. */
export const MAX_PENDING_ROWS = 1000;
/** Delivered rows kept for the status endpoint. Abandoned rows are never pruned. */
export const KEEP_SENT_ROWS = 200;

export type QueueState = 'pending' | 'sending' | 'sent' | 'abandoned';

export interface QueueRowView {
  id: number;
  kind: NotifyEventKind;
  state: QueueState;
  attempts: number;
  createdAt: string;
  nextAttemptAt: string;
  /** A category, never a response body. */
  lastError: string | null;
  sentAt: string | null;
}

interface QueueRow {
  id: number;
  created_at: string;
  kind: NotifyEventKind;
  event_json: string;
  locale: NotifyLocale;
  state: QueueState;
  attempts: number;
  next_attempt_at: string;
  throttle_key: string | null;
  last_error: string | null;
  claimed_at: string | null;
  sent_at: string | null;
}

/** Thrown when a caller tries to enqueue something that must not be persisted. */
export class NotifyEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotifyEventError';
  }
}

export interface EnqueueResult {
  /** The queue row, or null when the event was throttled or dropped. */
  readonly queued: number | null;
  readonly reason: 'queued' | 'throttled' | 'dropped';
}

export interface AttemptResult {
  readonly id: number;
  readonly state: QueueState;
  readonly attempts: number;
  readonly category: string | null;
}

export type ScheduleTimer = (fn: () => void, ms: number) => TimerHandle;

const realTimer: ScheduleTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return { stop: () => clearTimeout(timer) };
};

export interface NotifyServiceOptions {
  transport: NotificationTransport;
  audit: AuditService;
  db?: Database;
  clock?: Clock;
  /** Elided from every stored event, for the same reason the logger elides it. */
  basePath?: string;
  /** The locale every event is rendered in unless the caller names one. */
  locale?: NotifyLocale;
  /**
   * Builds the deep link for a project, or returns null.
   *
   * Absent means no links, which is the default: the link carries the base path, and a
   * Telegram message is storage the panel does not control.
   */
  linkFor?: (projectId: string) => string | null;
  /** Injected so the jitter is deterministic under test. */
  random?: () => number;
  startTimer?: ScheduleTimer;
  log?: (event: { message: string; id?: number; category?: string; state?: string }) => void;
  maxAttempts?: number;
  maxPending?: number;
}

export class NotifyService {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #audit: AuditService;
  readonly #transport: NotificationTransport;
  readonly #scrub: (value: string) => string;
  readonly #locale: NotifyLocale;
  readonly #linkFor: ((projectId: string) => string | null) | null;
  readonly #random: () => number;
  readonly #startTimer: ScheduleTimer;
  readonly #log: (event: {
    message: string;
    id?: number;
    category?: string;
    state?: string;
  }) => void;
  readonly #maxAttempts: number;
  readonly #maxPending: number;

  #timer: TimerHandle | null = null;
  #running = false;
  #started = false;

  constructor(opts: NotifyServiceOptions) {
    this.#db = opts.db ?? getDb();
    this.#clock = opts.clock ?? systemClock;
    this.#audit = opts.audit;
    this.#transport = opts.transport;
    const elide =
      opts.basePath === undefined || opts.basePath.length === 0
        ? (value: string): string => value
        : createBasePathElider(opts.basePath);
    this.#scrub = (value: string): string => elide(redactSecrets(value));
    this.#locale = opts.locale ?? 'en';
    this.#linkFor = opts.linkFor ?? null;
    this.#random = opts.random ?? Math.random;
    this.#startTimer = opts.startTimer ?? realTimer;
    this.#log = opts.log ?? ((): void => {});
    this.#maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_ATTEMPTS);
    this.#maxPending = Math.max(1, opts.maxPending ?? MAX_PENDING_ROWS);
  }

  // ── Enqueue ────────────────────────────────────────────────────────────────

  /**
   * Queues one typed event. One INSERT; never touches the network.
   *
   * Refuses a `SecretString` outright rather than redacting it, and refuses any
   * non-primitive value for the same reason `meta_json` validation does: events are
   * built from fixed shapes by this application's own code, so a violation is a bug,
   * and the loud version of a bug is the one that gets fixed. A queue table that
   * accumulates credentials is not something to discover months later.
   */
  notify(
    event: NotifyEvent,
    opts: { locale?: NotifyLocale; throttleKey?: string; throttleMs?: number } = {},
  ): EnqueueResult {
    assertNoSecrets(event);
    const clean = mapEventStrings(event, this.#scrub);
    const now = this.#clock.now();

    // The caller's own throttle, for producers that do not come through
    // `observeAudit` — the watchdog's OOM and unclean-restart alerts, both of which a
    // crash-looping container would otherwise enqueue every few seconds until the
    // queue cap started refusing security alerts to make room for them. Its absence
    // is the unthrottled behaviour every other caller already has, and
    // `EnqueueResult.reason` has carried a `'throttled'` variant since M1.7 for
    // exactly this.
    if (
      opts.throttleKey !== undefined &&
      opts.throttleMs !== undefined &&
      opts.throttleMs > 0 &&
      this.#throttled(opts.throttleKey, opts.throttleMs, now)
    ) {
      return { queued: null, reason: 'throttled' };
    }

    if (this.#pendingCount() >= this.#maxPending) return this.#drop();

    const id = Number(
      this.#db
        .prepare(
          `INSERT INTO notification_queue
             (created_at, kind, event_json, locale, state, attempts, next_attempt_at, throttle_key)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(
          isoFrom(now),
          clean.kind,
          JSON.stringify(clean),
          opts.locale ?? this.#locale,
          isoFrom(now),
          opts.throttleKey ?? null,
        ).lastInsertRowid,
    );

    // Something is due right now, so bring the next run forward. Cheap and idempotent.
    if (this.#started) this.#scheduleNext();
    return { queued: id, reason: 'queued' };
  }

  /**
   * Turns an audit row into a security alert, if the rules say so.
   *
   * Wired as an observer on `AuditService` rather than called from each route, so the
   * answer to "what does this panel tell me about?" stays one file. Never throws: a
   * notification failing must not roll back an audit write.
   */
  observeAudit(record: AuditRecord): void {
    try {
      const rule = ruleFor(record.event as AuditEventName);
      if (rule === null) return;

      const event = record.event as NotifiedAuditEvent;
      const previous = this.#lastThrottled(rule.throttleKey);
      if (previous !== null && this.#clock.now() - Date.parse(previous) < rule.throttleMs) return;

      // The suppressed count comes from the audit log, which is the authority — not
      // from an in-memory tally that a restart would lose. Minus one for this event,
      // whose row is already written by the time the observer runs.
      const suppressed =
        previous === null
          ? 0
          : Math.max(0, this.#countSince(countedEventsFor(event), previous, record.ts) - 1);

      const reason = record.meta.reason;
      this.notify(
        {
          kind: 'security_alert',
          event,
          outcome: record.outcome === 'failure' ? 'failure' : 'success',
          at: record.ts,
          suppressed,
          windowMinutes: Math.round(rule.throttleMs / 60_000),
          reason: typeof reason === 'string' ? reason : null,
        },
        { throttleKey: rule.throttleKey },
      );
    } catch (err) {
      this.#log({
        message: `notification rule failed: ${err instanceof Error ? err.name : 'unknown'}`,
      });
    }
  }

  #pendingCount(): number {
    return (
      this.#db
        .prepare("SELECT COUNT(*) AS c FROM notification_queue WHERE state IN ('pending','sending')")
        .get() as { c: number }
    ).c;
  }

  /**
   * The queue is full. Refuse the new event rather than evicting an old one.
   *
   * The first alert of an attack is the most valuable thing in the queue and the newest
   * is the most expendable, so eviction would drop exactly the wrong end. One audit row
   * per *fill* — not per refusal — because a flood that fills the queue would otherwise
   * flood the audit log behind it, and the audit log is what has to still be working
   * when everything else is not.
   */
  #drop(): EnqueueResult {
    const state = this.#db
      .prepare('SELECT dropped FROM notification_state WHERE id = 1')
      .get() as { dropped: number };
    const first = state.dropped === 0;
    this.#db
      .prepare(
        'UPDATE notification_state SET dropped = dropped + 1, dropped_since = COALESCE(dropped_since, ?), updated_at = ? WHERE id = 1',
      )
      .run(isoNow(this.#clock), isoNow(this.#clock));

    if (first) {
      this.#audit.write({
        event: AuditEvent.NotificationDropped,
        outcome: 'failure',
        meta: { cap: this.#maxPending },
      });
    }
    return { queued: null, reason: 'dropped' };
  }

  /**
   * Whether a row for this bucket is newer than the window.
   *
   * Reads the queue rather than an in-memory tally, so a restart does not reset the
   * window — which matters most for the one alert a crash loop produces on every boot.
   */
  #throttled(key: string, windowMs: number, nowMs: number): boolean {
    const previous = this.#lastThrottled(key);
    return previous !== null && nowMs - Date.parse(previous) < windowMs;
  }

  #lastThrottled(key: string): string | null {
    const row = this.#db
      .prepare('SELECT created_at FROM notification_queue WHERE throttle_key = ? ORDER BY id DESC LIMIT 1')
      .get(key) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  #countSince(events: readonly AuditEventName[], after: string, until: string): number {
    const placeholders = events.map(() => '?').join(', ');
    return (
      this.#db
        .prepare(
          `SELECT COUNT(*) AS c FROM audit_log
            WHERE event IN (${placeholders}) AND ts > ? AND ts <= ?`,
        )
        .get(...events, after, until) as { c: number }
    ).c;
  }

  // ── The worker ─────────────────────────────────────────────────────────────

  /**
   * Arms the chain. Called once at boot, after {@link sweepStale}.
   *
   * Deliberately not called by the constructor: the test suite builds this service
   * hundreds of times and drives {@link tick} by hand, and a service that armed a real
   * timer on construction would make every one of those a background job.
   */
  start(): void {
    this.#started = true;
    this.#scheduleNext();
  }

  stop(): void {
    this.#started = false;
    this.#timer?.stop();
    this.#timer = null;
  }

  get armed(): boolean {
    return this.#timer !== null;
  }

  /**
   * Reclaims rows a crash left mid-flight. Called once at boot, before {@link start}.
   *
   * Every `sending` row is reclaimed, not only the ones whose `next_attempt_at` has
   * passed: this process is the only worker, and it has just started, so a row marked
   * `sending` cannot be held by anybody. The attempt is **not** given back — a crash
   * during a send may well have been caused by the send — so a row that crashes the
   * process every time still reaches the attempt cap and dead-letters instead of
   * looping forever.
   */
  sweepStale(): { reclaimed: number } {
    const result = this.#db
      .prepare(
        `UPDATE notification_queue
            SET state = 'pending', claimed_at = NULL, last_error = COALESCE(last_error, 'reclaimed_after_restart')
          WHERE state = 'sending'`,
      )
      .run();
    if (result.changes > 0) {
      this.#log({ message: 'reclaimed in-flight notifications after a restart', id: result.changes });
    }
    return { reclaimed: result.changes };
  }

  /** The oldest due row, or null. */
  #claimNext(): QueueRow | null {
    const now = isoNow(this.#clock);
    const candidate = this.#db
      .prepare(
        `SELECT * FROM notification_queue
          WHERE state = 'pending' AND next_attempt_at <= ?
          ORDER BY id ASC LIMIT 1`,
      )
      .get(now) as QueueRow | undefined;
    if (candidate === undefined) return null;

    // The claim. `changes === 1` is what makes two workers impossible to interleave:
    // the loser's UPDATE matches no row, because the state is no longer 'pending'.
    const claimed = this.#db
      .prepare(
        `UPDATE notification_queue
            SET state = 'sending', attempts = attempts + 1, claimed_at = ?
          WHERE id = ? AND state = 'pending'`,
      )
      .run(now, candidate.id);
    if (claimed.changes !== 1) return null;

    return { ...candidate, state: 'sending', attempts: candidate.attempts + 1, claimed_at: now };
  }

  /**
   * Attempts the oldest due row, if there is one. Returns null when nothing is due.
   *
   * The whole body is guarded: this must never throw out of itself, because it runs from
   * a timer with nobody to catch it.
   */
  async tick(): Promise<AttemptResult | null> {
    let row: QueueRow | null = null;
    try {
      row = this.#claimNext();
      if (row === null) return null;
      return await this.#attempt(row);
    } catch (err) {
      const name = err instanceof Error ? err.name : 'unknown';
      this.#log({ message: `notification attempt threw: ${name}`, ...(row ? { id: row.id } : {}) });
      if (row !== null) this.#reschedule(row, `threw:${name}`, null);
      return null;
    }
  }

  /** Drains everything due, one at a time. Bounded, so a full queue cannot starve a boot. */
  async drain(limit = 50): Promise<number> {
    let done = 0;
    while (done < limit) {
      const result = await this.tick();
      if (result === null) break;
      done += 1;
    }
    return done;
  }

  async #attempt(row: QueueRow): Promise<AttemptResult> {
    const parsed: unknown = JSON.parse(row.event_json);
    if (!isNotifyEvent(parsed)) {
      // A row nothing can render. Abandoned rather than retried forever: the shape is
      // not going to improve on the fourth attempt.
      return this.#abandon(row, 'unrenderable_event');
    }

    const dict = DICTS[row.locale] ?? DICTS.en;
    const link =
      parsed.kind === 'turn_complete' && this.#linkFor !== null
        ? this.#linkFor(parsed.projectId)
        : null;
    const rendered = renderEvent(parsed, { locale: row.locale, link });

    const outcome = await this.#transport.send({
      text: rendered.text,
      documentName: `${row.kind}-${row.id}.txt`,
      truncationMarker: (characters) => dict.truncatedMarker(characters),
      documentCaption: dict.documentCaption(),
    });

    if (outcome.ok) {
      this.#db
        .prepare(
          `UPDATE notification_queue SET state = 'sent', sent_at = ?, last_error = NULL WHERE id = ?`,
        )
        .run(isoNow(this.#clock), row.id);
      this.#audit.write({
        event: AuditEvent.NotificationSent,
        outcome: 'success',
        // The queue row, the kind and the cost — never the message body, which is a
        // rendered event and would put in the audit log exactly what the queue holds.
        meta: {
          queueId: row.id,
          kind: row.kind,
          attempts: row.attempts,
          truncated: outcome.truncated,
          documentAttached: outcome.documentAttached,
        },
      });
      this.#pruneSent();
      this.#clearDropsIfDrained();
      return { id: row.id, state: 'sent', attempts: row.attempts, category: null };
    }

    const failure = outcome.failure!;
    const category = failureCategory(failure);

    // No configuration is a *state*, not a failure: the attempt is given back and the
    // row waits a minute. Otherwise a panel nobody has configured yet would dead-letter
    // two hours of security alerts and lose exactly the history the operator wanted.
    if (failure.kind === 'not_configured') {
      this.#db
        .prepare(
          `UPDATE notification_queue
              SET state = 'pending', attempts = attempts - 1, next_attempt_at = ?, last_error = ?
            WHERE id = ?`,
        )
        .run(isoFrom(this.#clock.now() + UNCONFIGURED_RETRY_MS), category, row.id);
      return { id: row.id, state: 'pending', attempts: row.attempts - 1, category };
    }

    if (row.attempts >= this.#maxAttempts) return this.#abandon(row, category);

    this.#reschedule(row, category, outcome.retryAfterSeconds);
    return { id: row.id, state: 'pending', attempts: row.attempts, category };
  }

  /**
   * Backoff: `2^(attempts-1)` seconds from one second, capped, jittered ±20 %.
   *
   * **Telegram's own `retry_after` overrides it outright** when there is one — not
   * averaged with it, not taken as a minimum. Telegram is the authority on when it will
   * accept the next request, and ignoring the figure it just gave is how a bot gets a
   * longer ban.
   */
  #reschedule(row: QueueRow, category: string, retryAfterSeconds: number | null): void {
    const delayMs =
      retryAfterSeconds !== null
        ? retryAfterSeconds * 1000
        : jitter(
            Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, row.attempts - 1)),
            this.#random(),
          );

    this.#db
      .prepare(
        `UPDATE notification_queue
            SET state = 'pending', next_attempt_at = ?, last_error = ?, claimed_at = NULL
          WHERE id = ?`,
      )
      .run(isoFrom(this.#clock.now() + delayMs), category, row.id);
    this.#log({ message: 'notification will be retried', id: row.id, category });
  }

  /**
   * A dead letter. The row **stays in the table**: "the panel tried to tell you and
   * could not" is itself information, and the queue is the only place it exists.
   */
  #abandon(row: QueueRow, category: string): AttemptResult {
    this.#db
      .prepare(
        `UPDATE notification_queue SET state = 'abandoned', last_error = ?, claimed_at = NULL WHERE id = ?`,
      )
      .run(category, row.id);
    this.#audit.write({
      event: AuditEvent.NotificationAbandoned,
      outcome: 'failure',
      meta: { queueId: row.id, kind: row.kind, attempts: row.attempts, category },
    });
    this.#log({ message: 'notification abandoned', id: row.id, category, state: 'abandoned' });
    return { id: row.id, state: 'abandoned', attempts: row.attempts, category };
  }

  /** Keeps the newest {@link KEEP_SENT_ROWS} delivered rows. Abandoned rows are kept. */
  #pruneSent(): void {
    this.#db
      .prepare(
        `DELETE FROM notification_queue
          WHERE state = 'sent'
            AND id NOT IN (
              SELECT id FROM notification_queue WHERE state = 'sent' ORDER BY id DESC LIMIT ?
            )`,
      )
      .run(KEEP_SENT_ROWS);
  }

  /** Once the queue has drained, a future fill is worth an audit row again. */
  #clearDropsIfDrained(): void {
    if (this.#pendingCount() > 0) return;
    this.#db
      .prepare('UPDATE notification_state SET dropped = 0, dropped_since = NULL, updated_at = ? WHERE id = 1')
      .run(isoNow(this.#clock));
  }

  /** Arms one timer for the moment the next row comes due. Nothing due, no timer. */
  #scheduleNext(): void {
    this.#timer?.stop();
    this.#timer = null;
    if (!this.#started) return;

    const next = this.#db
      .prepare(
        `SELECT MIN(next_attempt_at) AS due FROM notification_queue WHERE state = 'pending'`,
      )
      .get() as { due: string | null };
    if (next.due === null) return;

    const delay = Math.max(0, Date.parse(next.due) - this.#clock.now());
    this.#timer = this.#startTimer(() => void this.#run(), delay);
  }

  async #run(): Promise<void> {
    this.#timer = null;
    if (this.#running) return;
    this.#running = true;
    try {
      await this.drain();
    } finally {
      this.#running = false;
      this.#scheduleNext();
    }
  }

  // ── Reading it back ────────────────────────────────────────────────────────

  counts(): Record<QueueState, number> {
    const rows = this.#db
      .prepare('SELECT state, COUNT(*) AS c FROM notification_queue GROUP BY state')
      .all() as { state: QueueState; c: number }[];
    const counts: Record<QueueState, number> = { pending: 0, sending: 0, sent: 0, abandoned: 0 };
    for (const row of rows) counts[row.state] = row.c;
    return counts;
  }

  /** How many events were refused because the queue was full, since it last drained. */
  dropped(): { count: number; since: string | null } {
    const row = this.#db
      .prepare('SELECT dropped, dropped_since FROM notification_state WHERE id = 1')
      .get() as { dropped: number; dropped_since: string | null };
    return { count: row.dropped, since: row.dropped_since };
  }

  row(id: number): QueueRowView | null {
    const row = this.#db
      .prepare('SELECT * FROM notification_queue WHERE id = ?')
      .get(id) as QueueRow | undefined;
    return row === undefined ? null : toView(row);
  }

  lastSuccessAt(): string | null {
    const row = this.#db
      .prepare("SELECT MAX(sent_at) AS at FROM notification_queue WHERE state = 'sent'")
      .get() as { at: string | null };
    return row.at;
  }

  /** The newest failure, as a category and a time. Never a response body. */
  lastFailure(): { at: string; category: string } | null {
    const row = this.#db
      .prepare(
        `SELECT created_at, last_error FROM notification_queue
          WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 1`,
      )
      .get() as { created_at: string; last_error: string } | undefined;
    return row === undefined ? null : { at: row.created_at, category: row.last_error };
  }
}

function toView(row: QueueRow): QueueRowView {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    attempts: row.attempts,
    createdAt: row.created_at,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    sentAt: row.sent_at,
  };
}

/** ±{@link BACKOFF_JITTER} around `ms`, from an injected random in [0, 1). */
export function jitter(ms: number, random: number): number {
  const spread = ms * BACKOFF_JITTER;
  return Math.max(0, Math.round(ms - spread + random * spread * 2));
}

/**
 * Refuses a `SecretString`, and any value that is not a primitive.
 *
 * The second check is what catches a secret nested inside an object, which is how
 * something with a `toJSON` gets past the first one.
 */
function assertNoSecrets(value: unknown, path = 'event'): void {
  if (value instanceof SecretString) {
    throw new NotifyEventError(`${path} is a SecretString — notifications never carry one`);
  }
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) assertNoSecrets(child, `${path}.${key}`);
    return;
  }
  throw new NotifyEventError(`${path} is a ${typeof value}, which cannot be persisted`);
}
