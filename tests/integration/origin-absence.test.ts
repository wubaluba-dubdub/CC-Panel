import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/server/db.js';
import { AuditEvent } from '../../src/server/services/audit.service.js';
import {
  ORIGIN_ABSENCE_THROTTLE_MS,
  isOriginAbsentOnStateChange,
} from '../../src/server/plugins/origin-check.js';
import {
  SESSION_COOKIE,
  createAuthTestServer,
  enrollAccount,
  type AuthTestContext,
} from '../helpers/auth-harness.js';

/**
 * M1.6 part 1.1 — an admitted request with no `Origin` header is recorded.
 *
 * The behaviour under test is an *acceptance*, and it stays an acceptance. A
 * mutating request or a WebSocket handshake that carries no `Origin` at all is
 * admitted, because every browser attaches one to both, so an absent header means a
 * client that cannot be made to act for someone else. What changed is that the
 * acceptance is no longer silent: in production it should never happen, and the
 * audit log is the only place the operator would ever find out that it did.
 *
 * Two properties matter as much as the event itself, and both are asserted here:
 *
 * - **No session cookie, no row.** The root hook that observes this runs before the
 *   base-path 404 sink has answered and before the rate limiter charges anything, so
 *   an event written for every anonymous `POST` would let a scanner push real history
 *   out of a log with a retention cap.
 * - **Throttled, and it says what it suppressed.** The cookie test is presence-only
 *   by design (a live-session test would mean a database read at root scope on every
 *   request), so someone who has learned the base path can still send a garbage
 *   cookie. One row per window carries the whole signal; the count carries the rest.
 *
 * **Every assertion below is a delta, never an absolute count**, and that is not
 * defensive style — it is the finding. `app.inject` sends no `Origin`, so the
 * harness's own enrolment traffic is itself a genuine instance of the case being
 * recorded. A test that expected an empty table would be asserting that the feature
 * does not work.
 */

interface AbsenceRow {
  meta: Record<string, unknown>;
  userAgent: string | null;
}

/** Rows of the one event this file is about, oldest first. */
function absenceRows(): AbsenceRow[] {
  return (
    getDb()
      .prepare('SELECT user_agent, meta_json FROM audit_log WHERE event = ? ORDER BY id ASC')
      .all(AuditEvent.OriginAbsentAdmitted) as { user_agent: string | null; meta_json: string }[]
  ).map((row) => ({
    meta: JSON.parse(row.meta_json) as Record<string, unknown>,
    userAgent: row.user_agent,
  }));
}

/** Rows written since `baseline`. */
function since(baseline: number): AbsenceRow[] {
  return absenceRows().slice(baseline);
}

describe('the predicate is exactly the one the validator uses', () => {
  it('is true for a mutating method and for a handshake, and false otherwise', () => {
    const req = (over: Record<string, unknown>) => ({
      method: 'GET',
      headers: {},
      url: '/x/api/anything',
      ...over,
    });

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isOriginAbsentOnStateChange(req({ method })), method).toBe(true);
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(isOriginAbsentOnStateChange(req({ method })), method).toBe(false);
    }

    // A handshake is a GET. The whole reason the validator matches on `Upgrade`
    // rather than on the method is that this is the most state-changing request the
    // panel will ever serve, and the observer has to agree with it.
    expect(isOriginAbsentOnStateChange(req({ headers: { upgrade: 'websocket' } }))).toBe(true);
    expect(isOriginAbsentOnStateChange(req({ headers: { upgrade: 'h2c' } }))).toBe(false);
  });

  it('is false the moment an Origin is present, whatever its value', () => {
    for (const origin of ['https://panel.example.com', 'https://evil.example', 'null']) {
      expect(
        isOriginAbsentOnStateChange({
          method: 'POST',
          headers: { origin },
          url: '/x/api/anything',
        }),
        origin,
      ).toBe(false);
    }
  });

  it('treats a duplicated Origin header as absent, matching the validator', () => {
    // `soleValue` refuses to guess between two values, so the validator neither
    // rejects the request nor compares anything: it admits it. The observer has to
    // agree, or the row would describe a different set of requests than the check.
    expect(
      isOriginAbsentOnStateChange({
        method: 'POST',
        headers: { origin: ['https://a.example', 'https://b.example'] },
        url: '/x/api/anything',
      }),
    ).toBe(true);
  });
});

describe('the event is written for a request that carries a session cookie', () => {
  let ctx: AuthTestContext | null = null;

  afterEach(async () => {
    if (ctx !== null) await ctx.cleanup();
    ctx = null;
  });

  it('records the path and the method, and nothing that could be the cookie', async () => {
    // Unthrottled, so this request's own row is written rather than swallowed by the
    // window the enrolment above it opened.
    ctx = await createAuthTestServer({}, { originAbsenceThrottleMs: 0 });
    const account = await enrollAccount(ctx);
    const baseline = absenceRows().length;

    const res = await ctx.inject({
      method: 'POST',
      url: ctx.url('/api/sessions/revoke-others'),
      cookies: { [SESSION_COOKIE]: account.cookie },
      headers: { 'user-agent': 'panel-test' },
    });
    // Admitted, not rejected. That is the point of the whole exercise.
    expect(res.statusCode).toBe(200);

    const written = since(baseline);
    expect(written).toHaveLength(1);
    expect(written[0]!.meta).toEqual({
      // The base path is elided by the audit service, like every other string value.
      path: '/<base>/api/sessions/revoke-others',
      method: 'POST',
      suppressed: 0,
    });
    expect(written[0]!.userAgent).toBe('panel-test');

    // The row is about the shape of the request. The credential that made it
    // interesting is never in it, in any form.
    const raw = JSON.stringify(absenceRows());
    expect(raw).not.toContain(account.cookie);
    expect(raw).not.toContain(account.cookie.slice(0, 8));
    expect(raw).not.toContain(SESSION_COOKIE);
  });

  it('writes nothing when the same request carries a valid Origin', async () => {
    ctx = await createAuthTestServer({}, { originAbsenceThrottleMs: 0 });
    const account = await enrollAccount(ctx);
    const baseline = absenceRows().length;

    const res = await ctx.inject({
      method: 'POST',
      url: ctx.url('/api/sessions/revoke-others'),
      cookies: { [SESSION_COOKIE]: account.cookie },
      // The development fallback origin, which the loopback allowance accepts.
      headers: { origin: 'http://localhost' },
    });
    expect(res.statusCode).toBe(200);
    expect(since(baseline)).toHaveLength(0);
  });

  it('writes nothing for a safe method, however authenticated', async () => {
    ctx = await createAuthTestServer({}, { originAbsenceThrottleMs: 0 });
    const account = await enrollAccount(ctx);
    const baseline = absenceRows().length;

    const res = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/auth/me'),
      cookies: { [SESSION_COOKIE]: account.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(since(baseline)).toHaveLength(0);
  });
});

describe('a request with no session cookie cannot write the event', () => {
  let ctx: AuthTestContext | null = null;

  afterEach(async () => {
    if (ctx !== null) await ctx.cleanup();
    ctx = null;
  });

  it('writes nothing for the out-of-prefix 404 sink, so a scanner cannot flood the log', async () => {
    // Unthrottled, so a suppressed row cannot be mistaken for one that was never
    // written — the throttle would otherwise make this test pass for free.
    ctx = await createAuthTestServer({}, { originAbsenceThrottleMs: 0 });
    await enrollAccount(ctx);
    const baseline = absenceRows().length;
    expect(baseline).toBeGreaterThan(0);

    for (const url of ['/nope', '/wp-login.php', '/nope/deeper', '/']) {
      const res = await ctx.app.inject({ method: 'POST', url, payload: {} });
      // Everything outside the prefix is collapsed onto one sink before routing.
      expect(res.statusCode, url).toBe(404);
    }
    expect(since(baseline)).toHaveLength(0);
  });

  it('writes nothing for the login endpoint, which has no session to bind to', async () => {
    ctx = await createAuthTestServer({}, { originAbsenceThrottleMs: 0 });
    const baseline = absenceRows().length;

    // A real password step, with no cookie of any kind and no Origin — exactly the
    // request `csrf.test.ts` proves is exempt from the CSRF token, for the same
    // reason. It must not be an audit event either.
    const res = await ctx.app.inject({
      method: 'POST',
      url: ctx.url('/api/auth/login'),
      payload: { username: 'admin', password: 'correct-horse-battery-staple' },
    });
    expect(res.statusCode).toBe(200);
    expect(since(baseline)).toHaveLength(0);
  });

  it('writes nothing for a cookie that is not the session cookie', async () => {
    ctx = await createAuthTestServer({}, { originAbsenceThrottleMs: 0 });
    const baseline = absenceRows().length;

    const res = await ctx.app.inject({
      method: 'POST',
      url: ctx.url('/api/auth/login'),
      payload: { username: 'admin', password: 'correct-horse-battery-staple' },
      cookies: { unrelated: 'value' },
    });
    expect(res.statusCode).toBe(200);
    expect(since(baseline)).toHaveLength(0);
  });
});

describe('the event is throttled, and says how much it suppressed', () => {
  let ctx: AuthTestContext | null = null;

  afterEach(async () => {
    if (ctx !== null) await ctx.cleanup();
    ctx = null;
  });

  it('writes one row per window and counts the rest', async () => {
    ctx = await createAuthTestServer();
    const account = await enrollAccount(ctx);
    const post = async (): Promise<void> => {
      const res = await ctx!.inject({
        method: 'POST',
        url: ctx!.url('/api/sessions/revoke-others'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      expect(res.statusCode).toBe(200);
    };

    // Open a window of our own, so the enrolment traffic above is accounted for and
    // the counts below start from a known state rather than from the harness's.
    ctx.clock.advance(ORIGIN_ABSENCE_THROTTLE_MS + 1000);
    await post();
    const baseline = absenceRows().length;

    // Four more inside the window: silent.
    for (let i = 0; i < 4; i += 1) await post();
    expect(since(baseline)).toHaveLength(0);

    // One second short of the window: still silent.
    ctx.clock.advance(ORIGIN_ABSENCE_THROTTLE_MS - 1000);
    await post();
    expect(since(baseline)).toHaveLength(0);

    // Past it: one row, carrying the five occurrences it swallowed.
    ctx.clock.advance(2000);
    await post();
    const written = since(baseline);
    expect(written).toHaveLength(1);
    expect(written[0]!.meta.suppressed).toBe(5);
  });

  it('writes every occurrence when the window is zero, which is what proves the throttle', async () => {
    ctx = await createAuthTestServer({}, { originAbsenceThrottleMs: 0 });
    const account = await enrollAccount(ctx);
    const baseline = absenceRows().length;

    for (let i = 0; i < 3; i += 1) {
      const res = await ctx.inject({
        method: 'POST',
        url: ctx.url('/api/sessions/revoke-others'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(since(baseline)).toHaveLength(3);
    expect(since(baseline).map((r) => r.meta.suppressed)).toEqual([0, 0, 0]);
  });
});
