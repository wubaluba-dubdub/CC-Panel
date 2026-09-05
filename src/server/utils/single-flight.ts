/**
 * Serialises authentication attempts.
 *
 * Without this the progressive delay accomplishes nothing: an attacker fires a
 * thousand requests in parallel, all thousand sleep for the same target at the
 * same time, and the wall-clock cost of a thousand guesses is one delay period.
 * With it, at most one attempt executes at a time and the delays add up.
 *
 * Capacity is one running attempt plus `queueLimit` waiting. Anything beyond
 * that is rejected immediately with 429 rather than queued, so a burst cannot
 * pile up unbounded memory or unbounded latency. The rejection happens before
 * any credential is looked at, so it reveals nothing.
 */

export class SingleFlightBusyError extends Error {
  /** Picked up by the app's error handler and turned into a 429. */
  readonly statusCode = 429;

  /**
   * Distinct from `rate_limited`, and the distinction is the point.
   *
   * A 429 from the token bucket means *slow down*; this one means *an attempt is already
   * running*, which is neither a failure nor a rate limit and needs a different sentence on
   * screen. The client would otherwise tell the operator to wait `Retry-After` seconds when
   * the right advice is to wait for their own other tab.
   */
  readonly code = 'auth_in_progress' as const;

  constructor() {
    super('an authentication attempt is already in flight');
    this.name = 'SingleFlightBusyError';
  }
}

export class SingleFlight {
  readonly #queueLimit: number;

  /** Admitted calls that have not finished: the running one plus those waiting. */
  #inFlight = 0;

  /**
   * Resolves when the most recently admitted call has finished. Chaining onto it
   * is what enforces strict serialisation — and it is only ever *resolved*, never
   * rejected, so one failing attempt cannot unblock or poison the queue.
   */
  #tail: Promise<void> = Promise.resolve();

  constructor(queueLimit = 1) {
    if (!Number.isInteger(queueLimit) || queueLimit < 0) {
      throw new Error(`queueLimit must be a non-negative integer (got ${queueLimit})`);
    }
    this.#queueLimit = queueLimit;
  }

  /** Admitted calls that have not finished yet. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** One running plus `queueLimit` waiting. */
  get capacity(): number {
    return 1 + this.#queueLimit;
  }

  /**
   * Runs `task` with at most one task executing at a time.
   *
   * @throws {SingleFlightBusyError} when capacity is already taken. The check is
   * synchronous, before the first `await`, so a burst of parallel callers is
   * admitted or rejected deterministically rather than racing.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#inFlight >= this.capacity) throw new SingleFlightBusyError();
    this.#inFlight += 1;

    const predecessor = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await predecessor;
      return await task();
    } finally {
      this.#inFlight -= 1;
      release();
    }
  }
}
