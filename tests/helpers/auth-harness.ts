import { generateSync } from 'otplib';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions, Response as InjectResponse } from 'light-my-request';
import { createTestServer, type CreateTestServerOptions, type EnvOverrides, type TestContext } from './test-server.js';
import { FakeClock, createRecordedSleep, type RecordedSleep } from './fake-clock.js';
import { COOKIE_BASE_NAMES } from '../../src/server/plugins/cookies.js';
import { CSRF_HEADER, csrfTokenFor } from '../../src/server/services/csrf.service.js';
import { hashToken } from '../../src/server/services/session.service.js';

/**
 * The session cookie's name in the test environment.
 *
 * Tests run against a loopback http origin, which is the profile that drops the
 * `__Secure-` prefix, so the bare name is the correct one here.
 * `tests/integration/cookies.test.ts` is what pins the prefixed spelling under an
 * https public origin; nothing else should hard-code either form.
 */
export const SESSION_COOKIE = COOKIE_BASE_NAMES.session;
import {
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
} from '../../src/server/services/totp.service.js';

export const TEST_BASE = 'authtest';
export const TEST_USERNAME = 'admin';
export const TEST_PASSWORD = 'correct-horse-battery-staple';

/**
 * Generates a valid TOTP code for `secret` at a given moment.
 *
 * Uses the same library and the same parameters the server verifies with, so this
 * proves interoperability of *our* parameters, not of our arithmetic. The RFC 6238
 * reference vectors are pinned separately in `tests/unit/totp.test.ts`, which is
 * what catches a wrong period or a wrong algorithm.
 */
export function totpCodeAt(secret: string, epochMs: number, stepOffset = 0): string {
  return generateSync({
    secret,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    epoch: Math.floor(epochMs / 1000) + stepOffset * TOTP_PERIOD_SECONDS,
  });
}

export const CSRF_COOKIE = COOKIE_BASE_NAMES.csrf;

/**
 * Adds the CSRF pair to an injected request that carries a session cookie.
 *
 * A real client gets both cookies from the same `Set-Cookie` batch and echoes the
 * token in a header, so a test that only sends the session cookie is testing a
 * client that does not exist. This is what `ctx.inject` does automatically; a test
 * that wants to prove a *rejection* calls `ctx.app.inject` directly and controls
 * the pair by hand.
 *
 * The session id comes from resolving the token, which is what the server does too
 * — there is no way to compute the token from the cookie alone, by design.
 */
function withCsrf(app: FastifyInstance, opts: InjectOptions): InjectOptions {
  const cookies = (opts as { cookies?: Record<string, string> }).cookies;
  const token = cookies?.[SESSION_COOKIE];
  if (token === undefined) return opts;

  const session = app.auth.sessions.resolve(token);
  if (session === null) return opts;

  const csrf = csrfTokenFor(session.id, hashToken(token));
  return {
    ...opts,
    cookies: { ...cookies, [CSRF_COOKIE]: csrf },
    headers: {
      ...((opts.headers as Record<string, string> | undefined) ?? {}),
      [CSRF_HEADER]: csrf,
    },
  };
}

export interface AuthTestContext extends TestContext {
  clock: FakeClock;
  sleep: RecordedSleep;
  /** `/${basePath}` — every API path is built from this. */
  prefix: string;
  url(path: string): string;
  /**
   * `app.inject` with the CSRF pair filled in from the session cookie, which is what
   * a browser client would send. Use `ctx.app.inject` to test the raw wire.
   */
  inject(opts: InjectOptions): Promise<InjectResponse>;
  /** The session cookie value from a response, or null when none was set. */
  cookieFrom(res: InjectResponse): string | null;
  /** Whether the response cleared the session cookie. */
  clearedCookie(res: InjectResponse): boolean;
}

export async function createAuthTestServer(
  envOverrides: EnvOverrides = {},
  opts: Omit<CreateTestServerOptions, 'clock' | 'sleep'> & { clock?: FakeClock } = {},
): Promise<AuthTestContext> {
  const clock = opts.clock ?? new FakeClock();
  const sleep = createRecordedSleep(clock);

  const ctx = await createTestServer(
    // A key explicitly present as undefined wins, so a test can ask for a
    // generated base path rather than the pinned one.
    'PANEL_BASE_PATH' in envOverrides
      ? envOverrides
      : { PANEL_BASE_PATH: TEST_BASE, ...envOverrides },
    { ...opts, clock, sleep: sleep.sleep },
  );

  // Read back from the app rather than from the override, so a generated base
  // path works without the test having to guess it.
  const prefix = `/${ctx.app.basePath}`;

  return {
    ...ctx,
    clock,
    sleep,
    prefix,
    url: (path: string) => `${prefix}${path}`,
    inject: (opts: InjectOptions) => ctx.app.inject(withCsrf(ctx.app, opts)),
    cookieFrom: (res) => {
      const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
      if (cookie === undefined || cookie.value === '') return null;
      return cookie.value;
    },
    clearedCookie: (res) =>
      res.cookies.some((c) => c.name === SESSION_COOKIE && c.value === ''),
  };
}

/** `ctx.inject`, reachable from the helpers below before `ctx` is fully built. */
function injectWithCsrf(ctx: AuthTestContext, opts: InjectOptions): Promise<InjectResponse> {
  return ctx.app.inject(withCsrf(ctx.app, opts));
}

export interface EnrolledAccount {
  /** A full session cookie value. */
  cookie: string;
  /** The base32 TOTP secret, for generating codes. */
  secret: string;
  /** The ten recovery codes, in plaintext, as returned once at enrolment. */
  recoveryCodes: string[];
}

/** The password step. Returns the raw response so a test can assert on it. */
export async function postLogin(
  ctx: AuthTestContext,
  body: { username?: string; password?: string } = {},
): Promise<InjectResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: ctx.url('/api/auth/login'),
    payload: {
      username: body.username ?? TEST_USERNAME,
      password: body.password ?? TEST_PASSWORD,
    },
  });
}

/**
 * Drives first-run enrolment to completion: password step, enrol, confirm with a
 * generated code. Leaves the account with two-factor on and returns a full session.
 */
export async function enrollAccount(ctx: AuthTestContext): Promise<EnrolledAccount> {
  const login = await postLogin(ctx);
  if (login.statusCode !== 200) {
    throw new Error(`password step failed: ${login.statusCode} ${login.body}`);
  }
  const preCookie = ctx.cookieFrom(login);
  if (preCookie === null) throw new Error('password step set no cookie');

  const enroll = await injectWithCsrf(ctx, {
    method: 'POST',
    url: ctx.url('/api/auth/totp/enroll'),
    cookies: { [SESSION_COOKIE]: preCookie },
  });
  if (enroll.statusCode !== 200) {
    throw new Error(`enrolment failed: ${enroll.statusCode} ${enroll.body}`);
  }
  const { secret } = enroll.json() as { secret: string };

  const verify = await injectWithCsrf(ctx, {
    method: 'POST',
    url: ctx.url('/api/auth/totp/enroll/verify'),
    cookies: { [SESSION_COOKIE]: preCookie },
    payload: { code: totpCodeAt(secret, ctx.clock.now()) },
  });
  if (verify.statusCode !== 200) {
    throw new Error(`enrolment confirmation failed: ${verify.statusCode} ${verify.body}`);
  }

  const cookie = ctx.cookieFrom(verify);
  if (cookie === null) throw new Error('enrolment confirmation set no cookie');

  const { recoveryCodes } = verify.json() as { recoveryCodes: string[] };
  return { cookie, secret, recoveryCodes };
}

/**
 * A complete two-step login against an already-enrolled account.
 *
 * Advances the clock one step first, because the previous login in the same test
 * consumed the current step and replay protection — correctly — refuses to accept
 * it again.
 */
export async function loginFully(
  ctx: AuthTestContext,
  secret: string,
): Promise<{ cookie: string; response: InjectResponse }> {
  ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);

  const login = await postLogin(ctx);
  const preCookie = ctx.cookieFrom(login);
  if (preCookie === null) throw new Error(`password step set no cookie: ${login.body}`);

  const response = await injectWithCsrf(ctx, {
    method: 'POST',
    url: ctx.url('/api/auth/login/totp'),
    cookies: { [SESSION_COOKIE]: preCookie },
    payload: { code: totpCodeAt(secret, ctx.clock.now()) },
  });

  const cookie = ctx.cookieFrom(response);
  if (cookie === null) throw new Error(`second factor set no cookie: ${response.body}`);
  return { cookie, response };
}

/** Grants a step-up on `cookie`'s session. */
export async function stepUp(
  ctx: AuthTestContext,
  cookie: string,
  secret: string,
): Promise<InjectResponse> {
  ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
  return injectWithCsrf(ctx, {
    method: 'POST',
    url: ctx.url('/api/auth/step-up'),
    cookies: { [SESSION_COOKIE]: cookie },
    payload: { password: TEST_PASSWORD, code: totpCodeAt(secret, ctx.clock.now()) },
  });
}

export interface AuthedRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  url: string;
  payload?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** Convenience: an authenticated request with the session cookie attached. */
export function authed(
  app: FastifyInstance,
  cookie: string,
): (req: AuthedRequest) => Promise<InjectResponse> {
  return (req) =>
    app.inject(
      withCsrf(app, {
        method: req.method,
        url: req.url,
        cookies: { [SESSION_COOKIE]: cookie },
        ...(req.payload !== undefined ? { payload: req.payload } : {}),
        ...(req.headers !== undefined ? { headers: req.headers } : {}),
      }),
    );
}
