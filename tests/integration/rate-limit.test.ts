import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BODY_LIMIT_BYTES, REQUEST_TIMEOUT_MS } from '../../src/server/app.js';
import { DELAYED_AUTH_PATHS, RateLimiter } from '../../src/server/plugins/rate-limit.js';
import { MAX_DELAY_MS } from '../../src/server/services/auth-delay.service.js';
import { TokenBucket } from '../../src/server/utils/token-bucket.js';
import { FakeClock } from '../helpers/fake-clock.js';
import {
  SESSION_COOKIE,
  authed,
  createAuthTestServer,
  enrollAccount,
  loginFully,
  type AuthTestContext,
} from '../helpers/auth-harness.js';

/**
 * Rate limiting with **no per-IP anything** — M1.5.
 *
 * The shape of this control is forced by the no-per-IP decision in CLAUDE.md: the
 * operator arrives through tunnels with rotating addresses, so a bucket keyed on
 * the address would throttle the only legitimate user while an attacker rotated
 * for free. What is left is two buckets — one shared for traffic with no session,
 * one per session row — and the interesting properties are all about the seam
 * between them:
 *
 * - a stranger's anonymous flood must not throttle the operator, and
 * - an attacker must not be able to *mint* a bucket, which is why the session
 *   bucket is keyed on the resolved session id and never on the cookie as
 *   presented.
 *
 * The authentication endpoints are exempt on purpose. They already carry the
 * progressive delay and single-flight execution, which bind far earlier than a
 * bucket would; a bucket there would only hand a stranger a way to spend the
 * operator's tokens. The last describe is what stops a fifth delayed endpoint being
 * added without listing it.
 */

/** Small buckets, so a test empties one in three requests instead of sixty. */
const TINY = {
  anonymous: { capacity: 3, refillPerSecond: 0.5 },
  session: { capacity: 3, refillPerSecond: 4 },
};

describe('M1.5 — rate limiting without an address', () => {
  let ctx: AuthTestContext;

  afterEach(async () => {
    if (ctx !== undefined) await ctx.cleanup();
  });

  describe('the shared anonymous bucket', () => {
    it('empties, answers 429 with a computed Retry-After, and refills on the clock', async () => {
      ctx = await createAuthTestServer({}, { rateLimit: TINY });
      const me = ctx.url('/api/auth/me');

      // Three tokens, three unauthenticated requests. 401 is the route's answer;
      // what matters is that the limiter let them through.
      for (let i = 0; i < TINY.anonymous.capacity; i += 1) {
        const res = await ctx.app.inject({ method: 'GET', url: me });
        expect(res.statusCode, `request ${i + 1}`).toBe(401);
      }

      const limited = await ctx.app.inject({ method: 'GET', url: me });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual({ error: 'Too Many Requests' });
      // Half a token per second, so one token is two seconds away. Computed from the
      // refill rate rather than a constant, and never 0 — `Retry-After: 0` invites an
      // immediate retry that is guaranteed to fail again.
      expect(limited.headers['retry-after']).toBe('2');

      // Not enough to refill a whole token.
      ctx.clock.advance(1_000);
      expect((await ctx.app.inject({ method: 'GET', url: me })).statusCode).toBe(429);

      ctx.clock.advance(1_100);
      expect((await ctx.app.inject({ method: 'GET', url: me })).statusCode).toBe(401);
    });

    it('cannot be escaped by presenting a fresh unresolvable cookie each time', async () => {
      // The session bucket is keyed on the *resolved* session id. Keying on the
      // cookie as presented would let an attacker mint a brand-new bucket per
      // request by sending a brand-new garbage value, which is an unlimited channel
      // wearing a rate limiter's clothes.
      ctx = await createAuthTestServer({}, { rateLimit: TINY });
      const me = ctx.url('/api/auth/me');

      for (let i = 0; i < TINY.anonymous.capacity; i += 1) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: me,
          cookies: { [SESSION_COOKIE]: `garbage-${i}-${'x'.repeat(40)}` },
        });
        expect(res.statusCode, `request ${i + 1}`).toBe(401);
      }

      const limited = await ctx.app.inject({
        method: 'GET',
        url: me,
        cookies: { [SESSION_COOKIE]: `garbage-final-${'x'.repeat(40)}` },
      });
      expect(limited.statusCode).toBe(429);
    });

    it('exempts /healthz, because a throttled health probe is a container-kill primitive', async () => {
      ctx = await createAuthTestServer({}, { rateLimit: TINY });
      const me = ctx.url('/api/auth/me');
      for (let i = 0; i < TINY.anonymous.capacity + 2; i += 1) {
        await ctx.app.inject({ method: 'GET', url: me });
      }
      expect((await ctx.app.inject({ method: 'GET', url: me })).statusCode).toBe(429);

      const health = await ctx.app.inject({ method: 'GET', url: '/healthz' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ ok: true });
    });
  });

  describe('one bucket per session row', () => {
    /**
     * Two full, concurrently valid sessions, with every bucket refilled.
     *
     * `loginFully` advances the clock a TOTP step per login, which is itself enough
     * to refill a bucket, so the counting below starts from a known-full state
     * rather than from whatever enrolment happened to spend.
     */
    async function twoSessions(): Promise<{ a: string; b: string }> {
      const account = await enrollAccount(ctx);
      const second = await loginFully(ctx, account.secret);
      ctx.clock.advance(60_000);
      return { a: account.cookie, b: second.cookie };
    }

    it('throttles one session without touching the other', async () => {
      ctx = await createAuthTestServer({}, { rateLimit: TINY });
      const { a, b } = await twoSessions();
      const asA = authed(ctx.app, a);
      const asB = authed(ctx.app, b);
      const me = ctx.url('/api/auth/me');

      for (let i = 0; i < TINY.session.capacity; i += 1) {
        expect((await asA({ method: 'GET', url: me })).statusCode, `A #${i + 1}`).toBe(200);
      }
      const limited = await asA({ method: 'GET', url: me });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBe('1');

      // A busy — or compromised — session must not be able to throttle the other.
      expect((await asB({ method: 'GET', url: me })).statusCode).toBe(200);
    });

    it('does not let a stranger\'s anonymous flood throttle the operator', async () => {
      // This is the whole reason there are two buckets rather than one global one.
      ctx = await createAuthTestServer({}, { rateLimit: TINY });
      const { a } = await twoSessions();
      const me = ctx.url('/api/auth/me');

      for (let i = 0; i < TINY.anonymous.capacity + 1; i += 1) {
        await ctx.app.inject({ method: 'GET', url: me });
      }
      expect((await ctx.app.inject({ method: 'GET', url: me })).statusCode).toBe(429);

      expect((await authed(ctx.app, a)({ method: 'GET', url: me })).statusCode).toBe(200);
    });

    it('ends the request there — a 429 must not also run the handler', async () => {
      // An async `onRequest` hook that sends a reply and returns nothing leaves
      // Fastify to run the route as well, so the side effect happens anyway and the
      // framework then complains that the reply was already sent. The observable
      // proof is that the other session survives.
      ctx = await createAuthTestServer({}, { rateLimit: TINY });
      const { a, b } = await twoSessions();
      const asA = authed(ctx.app, a);
      const me = ctx.url('/api/auth/me');

      for (let i = 0; i < TINY.session.capacity; i += 1) {
        expect((await asA({ method: 'GET', url: me })).statusCode).toBe(200);
      }

      const revoke = await asA({ method: 'POST', url: ctx.url('/api/sessions/revoke-others') });
      expect(revoke.statusCode).toBe(429);
      expect(ctx.app.auth.sessions.resolve(b), 'the other session survived the 429').not.toBeNull();
    });
  });
  describe('the authentication endpoints are exempt, and that is a decision', () => {
    it('lets every delayed endpoint through an empty anonymous bucket', async () => {
      // The progressive delay and single-flight execution already price these far
      // more expensively than a bucket could, and they price the *attempt* rather
      // than the request — so a bucket here would add nothing an attacker notices
      // while handing a stranger a way to lock the operator out of the login page.
      ctx = await createAuthTestServer({}, { rateLimit: TINY });
      const me = ctx.url('/api/auth/me');
      for (let i = 0; i < TINY.anonymous.capacity + 1; i += 1) {
        await ctx.app.inject({ method: 'GET', url: me });
      }
      expect((await ctx.app.inject({ method: 'GET', url: me })).statusCode).toBe(429);

      for (const path of DELAYED_AUTH_PATHS) {
        const res = await ctx.app.inject({ method: 'POST', url: ctx.url(path), payload: {} });
        expect(res.statusCode, `${path} answered ${res.statusCode}`).not.toBe(429);
      }
    });

    it('lists exactly the endpoints that are wrapped in runAuthAttempt', async () => {
      // The two facts that must not drift apart: an endpoint inside the delay is
      // exempt from the bucket, and an endpoint outside it is not. A fifth
      // `runAuthAttempt` call site added without a line in DELAYED_AUTH_PATHS would
      // be silently double-priced; a stale member would leave a real endpoint
      // unlimited. Neither is visible by reading either file alone.
      const source = readFileSync('src/server/routes/auth.ts', 'utf8');
      const callSites = source.match(/runAuthAttempt\(/g) ?? [];
      expect(callSites.length).toBe(DELAYED_AUTH_PATHS.size);

      // And each listed path is a route that exists, so a typo cannot masquerade as
      // an exemption.
      for (const path of DELAYED_AUTH_PATHS) {
        expect(source, path).toContain(`'${path}'`);
      }
    });
  });

  describe('request limits, which are bounded without an address too', () => {
    it('rejects a body over the limit with 413 and a bare reason phrase', async () => {
      ctx = await createAuthTestServer();
      const oversized = 'x'.repeat(BODY_LIMIT_BYTES + 1024);
      const res = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login'),
        payload: { username: 'admin', password: oversized },
      });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({ error: 'Payload Too Large' });

      // Under the limit the body reaches the schema, which is where the per-field
      // maxima in `utils/zod-schemas.ts` take over. Whatever it answers, it is not
      // the transport refusing to read it.
      const under = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login'),
        payload: { username: 'admin', password: 'x'.repeat(1024) },
      });
      expect(under.statusCode).not.toBe(413);
    });

    it('bounds how long a client may take to deliver a request', async () => {
      // Read off the running server, not off the constant, because a `requestTimeout`
      // that never reached Fastify's options is exactly the failure this catches.
      ctx = await createAuthTestServer();
      expect(ctx.app.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
      expect(ctx.app.initialConfig.bodyLimit).toBe(BODY_LIMIT_BYTES);

      // It bounds *receipt* of a request, not the handler, which is what makes it
      // safe to set at all: a failed login pads its response by up to MAX_DELAY_MS
      // from inside the handler, and a timeout that counted handler time would cut
      // every slow-path login off at the knees.
      expect(REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(MAX_DELAY_MS);
    });
  });
});

describe('TokenBucket', () => {
  const bucketAt = (capacity: number, refillPerSecond: number, clock: FakeClock): TokenBucket =>
    new TokenBucket({ capacity, refillPerSecond, clock });

  it('spends down to empty and refills at the configured rate', () => {
    const clock = new FakeClock();
    const bucket = bucketAt(2, 1, clock);

    expect(bucket.take(clock.now())).toEqual({ ok: true, retryAfterSeconds: 0, remaining: 1 });
    expect(bucket.take(clock.now())).toEqual({ ok: true, retryAfterSeconds: 0, remaining: 0 });
    expect(bucket.take(clock.now())).toEqual({ ok: false, retryAfterSeconds: 1, remaining: 0 });

    // Half a token is not a token, and the advice is still to wait a whole second.
    clock.advance(500);
    expect(bucket.take(clock.now())).toEqual({ ok: false, retryAfterSeconds: 1, remaining: 0 });
    clock.advance(500);
    expect(bucket.take(clock.now()).ok).toBe(true);
  });

  it('never advises a retry of zero seconds', () => {
    // `Retry-After: 0` invites an immediate retry that is guaranteed to fail again,
    // which is a busy loop the server asked for.
    const clock = new FakeClock();
    const bucket = bucketAt(1, 100, clock);
    bucket.take(clock.now());
    expect(bucket.take(clock.now()).retryAfterSeconds).toBe(1);
  });

  it('does not accumulate past capacity, and reports fullness', () => {
    const clock = new FakeClock();
    const bucket = bucketAt(3, 1, clock);
    bucket.take(clock.now());
    bucket.take(clock.now());
    expect(bucket.isFull(clock.now())).toBe(false);

    clock.advance(60_000);
    expect(bucket.isFull(clock.now())).toBe(true);
    expect(bucket.take(clock.now()).remaining).toBe(2);
  });

  it('mints nothing when the clock goes backwards', () => {
    // An NTP step, or a test that rewound its fake clock. Negative elapsed time must
    // not become free tokens, and it must not freeze the bucket either.
    const clock = new FakeClock();
    const bucket = bucketAt(1, 1, clock);
    expect(bucket.take(clock.now()).ok).toBe(true);
    expect(bucket.take(clock.now() - 60_000).ok).toBe(false);
    clock.advance(2_000);
    expect(bucket.take(clock.now()).ok).toBe(true);
  });

  it('refuses a nonsensical configuration at construction', () => {
    const clock = new FakeClock();
    expect(() => bucketAt(0, 1, clock)).toThrow(/capacity/);
    expect(() => bucketAt(1, 0, clock)).toThrow(/refill/);
  });
});

describe('RateLimiter bookkeeping', () => {
  function fakeReply(): { reply: FastifyReply; seen: { status: number; retryAfter: string } } {
    const seen = { status: 0, retryAfter: '' };
    const reply = {
      code(status: number) {
        seen.status = status;
        return reply;
      },
      header(name: string, value: string) {
        if (name === 'retry-after') seen.retryAfter = value;
        return reply;
      },
      async send() {
        return reply;
      },
    };
    return { reply: reply as unknown as FastifyReply, seen };
  }

  const request = (url: string, sessionId: number | null): FastifyRequest =>
    ({
      raw: { url },
      session: sessionId === null ? null : { id: sessionId },
    }) as unknown as FastifyRequest;

  it('forgets buckets that have refilled, so the map is bounded by activity', async () => {
    // A full bucket is indistinguishable from a new one, so keeping it only holds
    // memory. Without this the map would be bounded by the number of sessions that
    // have ever existed.
    const clock = new FakeClock();
    const limiter = new RateLimiter({
      basePath: 'basepath',
      clock,
      session: { capacity: 5, refillPerSecond: 1 },
    });
    const hook = limiter.sessionAware();
    const url = '/basepath/api/auth/me';

    for (let id = 1; id <= 40; id += 1) {
      await hook.call(null as never, request(url, id), fakeReply().reply);
    }
    expect(limiter.trackedSessions).toBe(40);

    // Long enough for every bucket to be back at capacity.
    clock.advance(30_000);
    await hook.call(null as never, request(url, 999), fakeReply().reply);
    expect(limiter.trackedSessions).toBe(1);
  });

  it('charges the anonymous bucket for a session-less request in either scope', async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({
      basePath: 'basepath',
      clock,
      anonymous: { capacity: 2, refillPerSecond: 1 },
    });
    const url = '/basepath/api/auth/me';

    // One bucket, shared: spending it through the API scope leaves nothing for the
    // shell scope, which is what "one shared anonymous bucket" means.
    await limiter.sessionAware().call(null as never, request(url, null), fakeReply().reply);
    await limiter.anonymousOnly().call(null as never, request('/basepath/', null), fakeReply().reply);

    const rejected = fakeReply();
    await limiter.anonymousOnly().call(null as never, request('/basepath/', null), rejected.reply);
    expect(rejected.seen.status).toBe(429);
    expect(rejected.seen.retryAfter).toBe('1');
    expect(limiter.trackedSessions).toBe(0);
  });

  it('matches its exemptions against the path with the base-path prefix removed', async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({
      basePath: 'basepath',
      clock,
      anonymous: { capacity: 1, refillPerSecond: 1 },
    });
    const hook = limiter.sessionAware();

    // The prefix is a per-install secret, so the exemption list cannot spell it: the
    // list is relative, and the prefix is stripped before the comparison.
    for (const url of ['/healthz', '/basepath/api/auth/login', '/basepath/api/auth/step-up']) {
      const exempt = fakeReply();
      await hook.call(null as never, request(url, null), exempt.reply);
      expect(exempt.seen.status, url).toBe(0);
    }

    // The single anonymous token is therefore still unspent, and the first
    // non-exempt request takes it.
    const first = fakeReply();
    await hook.call(null as never, request('/basepath/api/auth/me', null), first.reply);
    expect(first.seen.status).toBe(0);

    const second = fakeReply();
    await hook.call(null as never, request('/basepath/api/auth/me', null), second.reply);
    expect(second.seen.status).toBe(429);
  });
});
