import type { Clock } from './clock.js';

/**
 * A token bucket, keyed on nothing by itself.
 *
 * The caller decides what a bucket represents — see `plugins/rate-limit.ts`, where
 * there is exactly one shared bucket for unauthenticated traffic and one per
 * session. Neither is keyed on an address, which is the whole point: the operator
 * reaches this panel through tunnels with rotating addresses, so a per-IP bucket
 * would throttle the one legitimate user while an attacker rotated for free. See
 * the no-per-IP decision in CLAUDE.md.
 *
 * The clock is injected for the same reason it is everywhere else in this
 * codebase: a suite that had to wait for a refill would be slow and flaky.
 */
export interface BucketVerdict {
  ok: boolean;
  /** Seconds until one token is available. 0 when `ok`. */
  retryAfterSeconds: number;
  /** Whole tokens left after this call, for tests and headers. */
  remaining: number;
}

export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSecond: number;
  #tokens: number;
  #lastMs: number;

  constructor(opts: { capacity: number; refillPerSecond: number; clock: Clock }) {
    if (opts.capacity < 1) throw new Error('token bucket capacity must be at least 1');
    if (opts.refillPerSecond <= 0) throw new Error('token bucket refill must be positive');
    this.capacity = opts.capacity;
    this.refillPerSecond = opts.refillPerSecond;
    this.#tokens = opts.capacity;
    this.#lastMs = opts.clock.now();
  }

  /** True when the bucket is back to full — the signal that it can be forgotten. */
  isFull(nowMs: number): boolean {
    this.#refill(nowMs);
    return this.#tokens >= this.capacity;
  }

  #refill(nowMs: number): void {
    // A clock that went backwards (a test's fake clock rewound, an NTP step) must
    // not mint tokens or freeze the bucket: treat it as no elapsed time.
    const elapsedMs = Math.max(0, nowMs - this.#lastMs);
    this.#lastMs = nowMs;
    if (elapsedMs === 0) return;
    this.#tokens = Math.min(this.capacity, this.#tokens + (elapsedMs / 1000) * this.refillPerSecond);
  }

  take(nowMs: number): BucketVerdict {
    this.#refill(nowMs);
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return { ok: true, retryAfterSeconds: 0, remaining: Math.floor(this.#tokens) };
    }
    // Ceiling, and never zero: `Retry-After: 0` invites an immediate retry that is
    // guaranteed to fail again.
    const retryAfterSeconds = Math.max(1, Math.ceil((1 - this.#tokens) / this.refillPerSecond));
    return { ok: false, retryAfterSeconds, remaining: 0 };
  }
}
