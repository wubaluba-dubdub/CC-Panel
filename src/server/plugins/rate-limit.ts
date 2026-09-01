import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { Clock } from '../utils/clock.js';
import { TokenBucket } from '../utils/token-bucket.js';
import { pathnameOf } from '../utils/timing-safe.js';
import { HEALTHZ_PATH } from './base-path.js';

/**
 * The four endpoints wrapped in `runAuthAttempt`.
 *
 * They are exempt from this limiter, and that is a decision, not an oversight.
 * They already carry two stronger controls: the progressive delay, which makes
 * guess *n* cost up to thirty seconds, and single-flight execution, which admits
 * one attempt at a time and 429s the third concurrent one. Stacking a bucket on
 * top would add nothing an attacker notices — the delay is the binding constraint
 * long before a bucket would empty — while giving anyone who can reach the login
 * endpoint a way to spend the operator's own tokens. Paths are relative to the
 * base-path prefix.
 *
 * `tests/integration/rate-limit.test.ts` asserts this set has exactly as many
 * members as `routes/auth.ts` has `runAuthAttempt(` call sites, so a fifth delayed
 * endpoint cannot be added without either listing it here or failing the suite.
 */
export const DELAYED_AUTH_PATHS: ReadonlySet<string> = new Set([
  '/api/auth/login',
  '/api/auth/login/totp',
  '/api/auth/totp/enroll/verify',
  '/api/auth/step-up',
]);

export interface RateLimitOptions {
  basePath: string;
  clock: Clock;
  /** Shared across every unauthenticated request. */
  anonymous?: { capacity: number; refillPerSecond: number };
  /** One bucket per session row. */
  session?: { capacity: number; refillPerSecond: number };
}

/**
 * Rate limiting with no per-IP anything.
 *
 * Two buckets, because one would be a hole either way. A single global bucket lets
 * an anonymous flood empty it and 429 the operator — a denial of service handed to
 * anyone who can reach the panel. A purely per-session bucket cannot limit
 * unauthenticated traffic at all, because an unauthenticated request has no
 * identity to key on that the client cannot simply discard. So:
 *
 * - **Anonymous bucket**: one shared bucket, charged for requests with no live
 *   session. Deliberately small, and deliberately shared: the only unauthenticated
 *   surface is the shell, `bootstrap.js`, and the login endpoints, so a legitimate
 *   client draws from it a handful of times before it has a session and stops
 *   touching it entirely.
 * - **Session bucket**: one per session row, charged for authenticated requests, so
 *   a busy operator is never throttled by a stranger's flood and vice versa. Keyed
 *   on the *resolved* session id, never on a raw cookie value — keying on
 *   unvalidated input would let an attacker mint a fresh bucket per request by
 *   sending a fresh garbage cookie.
 *
 * Exempt: `/healthz` (a 429'd health probe is a container-kill primitive — Docker's
 * `HEALTHCHECK` failing three times stops the container) and
 * {@link DELAYED_AUTH_PATHS}. The out-of-prefix 404 sink is also unlimited,
 * because the base-path gate collapses every miss onto one constant URL before
 * routing and the handler does no work but write a fixed body; adding a bucket
 * there would let a stranger's scan spend tokens that matter.
 *
 * The clock is injected, so the suite can prove a refill without waiting for one.
 */
export class RateLimiter {
  readonly #clock: Clock;
  readonly #prefix: string;
  readonly #anonymous: TokenBucket;
  readonly #sessionBuckets = new Map<number, TokenBucket>();
  readonly #sessionSpec: { capacity: number; refillPerSecond: number };

  constructor(opts: RateLimitOptions) {
    this.#clock = opts.clock;
    this.#prefix = `/${opts.basePath}`;
    // 60 tokens, one back per second. A cold client load is a handful of requests;
    // a login flood is four requests before the delay takes over.
    const anonymous = opts.anonymous ?? { capacity: 60, refillPerSecond: 1 };
    this.#anonymous = new TokenBucket({ ...anonymous, clock: opts.clock });
    // 120 tokens, four back per second: generous for a panel driven by one person
    // and one SPA, tight enough to bound a compromised session's throughput.
    this.#sessionSpec = opts.session ?? { capacity: 120, refillPerSecond: 4 };
  }

  /** Buckets currently tracked, for tests and for the eviction assertion. */
  get trackedSessions(): number {
    return this.#sessionBuckets.size;
  }

  /** The request path with the base-path prefix removed, for exemption matching. */
  #relativePath(rawUrl: string | undefined): string {
    const pathname = pathnameOf(rawUrl ?? '/');
    if (pathname === this.#prefix) return '/';
    if (pathname.startsWith(`${this.#prefix}/`)) return pathname.slice(this.#prefix.length);
    return pathname;
  }

  #exempt(rawUrl: string | undefined): boolean {
    const path = this.#relativePath(rawUrl);
    return path === HEALTHZ_PATH || DELAYED_AUTH_PATHS.has(path);
  }

  #bucketForSession(id: number): TokenBucket {
    let bucket = this.#sessionBuckets.get(id);
    if (bucket === undefined) {
      bucket = new TokenBucket({ ...this.#sessionSpec, clock: this.#clock });
      this.#sessionBuckets.set(id, bucket);
    }
    return bucket;
  }

  /**
   * Drops buckets that have refilled completely.
   *
   * A full bucket is indistinguishable from a new one, so keeping it only holds
   * memory. Called opportunistically on the authenticated path, which bounds the
   * map by the number of sessions active within one refill window rather than by
   * the number of sessions that have ever existed.
   */
  #evictIdle(nowMs: number, exceptId: number): void {
    if (this.#sessionBuckets.size < 32) return;
    for (const [id, bucket] of this.#sessionBuckets) {
      if (id !== exceptId && bucket.isFull(nowMs)) this.#sessionBuckets.delete(id);
    }
  }

  /**
   * Ends the lifecycle here.
   *
   * The reply is `await`ed and then returned, which is how an async hook tells
   * Fastify it has answered: returning nothing after `send()` leaves the framework
   * to run the route handler as well and then complain that the reply was already
   * sent.
   */
  async #reject(reply: FastifyReply, retryAfterSeconds: number): Promise<FastifyReply> {
    await reply
      .code(429)
      .header('retry-after', String(retryAfterSeconds))
      .send({ error: 'Too Many Requests' });
    return reply;
  }

  /**
   * For scopes that have already resolved the session (the API): charges the
   * session's own bucket when there is one, the shared anonymous bucket when there
   * is not. Install **after** `attachSession`.
   */
  sessionAware(): onRequestAsyncHookHandler {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      if (this.#exempt(req.raw.url)) return undefined;
      const now = this.#clock.now();

      if (req.session === null) {
        const verdict = this.#anonymous.take(now);
        return verdict.ok ? undefined : this.#reject(reply, verdict.retryAfterSeconds);
      }

      const bucket = this.#bucketForSession(req.session.id);
      const verdict = bucket.take(now);
      this.#evictIdle(now, req.session.id);
      return verdict.ok ? undefined : this.#reject(reply, verdict.retryAfterSeconds);
    };
  }

  /**
   * For scopes with no session resolution (the shell and `bootstrap.js`): always
   * the shared anonymous bucket. Resolving a session there would add a database
   * read to every asset fetch to gain nothing, since those routes are readable
   * without one.
   */
  anonymousOnly(): onRequestAsyncHookHandler {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      if (this.#exempt(req.raw.url)) return undefined;
      const verdict = this.#anonymous.take(this.#clock.now());
      return verdict.ok ? undefined : this.#reject(reply, verdict.retryAfterSeconds);
    };
  }
}
