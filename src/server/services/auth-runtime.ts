import type { Database } from 'better-sqlite3';
import type { Env } from '../env.js';
import { getDb } from '../db.js';
import { createCookieJar, type CookieJar } from '../plugins/cookies.js';
import type { PublicOrigin } from '../utils/public-origin.js';
import { type Clock, type Sleep, realSleep, systemClock } from '../utils/clock.js';
import { SingleFlight } from '../utils/single-flight.js';
import { AuditService } from './audit.service.js';
import { AuthDelayService } from './auth-delay.service.js';
import { RecoveryCodesService } from './recovery-codes.service.js';
import { SecretsRepository } from './secrets.service.js';
import { SessionService } from './session.service.js';
import { TotpService } from './totp.service.js';
import { UserService } from './user.service.js';

/**
 * Everything the authentication routes need, built once at boot and passed down
 * explicitly rather than reached for through a module-level singleton.
 *
 * The point of threading it through is `clock` and `sleep`: the delay schedule
 * tops out at thirty seconds, and a test suite that waited for that in real time
 * would be unusable. Injecting them lets the suite assert against the *computed*
 * target instead of against wall-clock elapsed time, which is also the only way
 * to assert it without flakiness.
 */
export interface AuthRuntime {
  readonly env: Env;
  readonly basePath: string;
  /**
   * The configured public origin. Decided once, in `utils/public-origin.ts`, and
   * read from here by both the cookie jar and the Origin/Host validator so the two
   * cannot disagree about what this panel's own origin is.
   */
  readonly origin: PublicOrigin;
  /** The only thing in this process that names or attributes a cookie. */
  readonly cookies: CookieJar;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly db: Database;
  readonly users: UserService;
  readonly sessions: SessionService;
  readonly totp: TotpService;
  readonly recovery: RecoveryCodesService;
  readonly delay: AuthDelayService;
  readonly audit: AuditService;
  readonly secrets: SecretsRepository;
  /**
   * One gate for every authentication endpoint, shared. Sharing it is the whole
   * point: separate gates per route would let an attacker run a password guess
   * and a code guess concurrently and halve the cost of the delay.
   */
  readonly gate: SingleFlight;
}

export interface AuthRuntimeOptions {
  env: Env;
  basePath: string;
  origin: PublicOrigin;
  clock?: Clock;
  sleep?: Sleep;
  db?: Database;
  /** One running attempt plus this many queued; anything more gets a 429. */
  queueLimit?: number;
}

export function createAuthRuntime(opts: AuthRuntimeOptions): AuthRuntime {
  const clock = opts.clock ?? systemClock;
  const sleep = opts.sleep ?? realSleep;
  const db = opts.db ?? getDb();

  return {
    env: opts.env,
    basePath: opts.basePath,
    origin: opts.origin,
    cookies: createCookieJar({
      origin: opts.origin,
      basePath: opts.basePath,
      nodeEnv: opts.env.NODE_ENV,
      clock,
    }),
    clock,
    sleep,
    db,
    users: new UserService({ db, clock }),
    sessions: new SessionService({ db, clock }),
    totp: new TotpService({ db, clock }),
    recovery: new RecoveryCodesService({ db, clock }),
    delay: new AuthDelayService({ db, clock, sleep }),
    audit: new AuditService({ db, clock, basePath: opts.basePath }),
    secrets: new SecretsRepository({ db, clock }),
    gate: new SingleFlight(opts.queueLimit ?? 1),
  };
}
