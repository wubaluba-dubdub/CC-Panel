import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER, csrfTokenFor } from '../../src/server/services/csrf.service.js';
import { hashToken } from '../../src/server/services/session.service.js';
import { TOTP_PERIOD_SECONDS } from '../../src/server/services/totp.service.js';
import { curl, fromJar, listenLoopback, type CurlResult } from '../helpers/curl.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  TEST_PASSWORD,
  TEST_USERNAME,
  createAuthTestServer,
  enrollAccount,
  loginFully,
  postLogin,
  totpCodeAt,
  type AuthTestContext,
} from '../helpers/auth-harness.js';

/**
 * Double-submit CSRF, driven end to end by `curl` against a real listening socket.
 *
 * The wire is the point: the pair under test is the one the server actually wrote
 * to a client and the client actually echoed back, not one the test computed. See
 * `tests/helpers/curl.ts` for why a real client needs asynchronous curl and
 * `--noproxy`, and for the jar format.
 *
 * Nothing here needs a browser: curl's jar honours `Path`, `Max-Age` and the
 * `HttpOnly` bookkeeping, and the `HttpOnly` cookie is deliberately the one the
 * test never has to read for the mechanism to work.
 */

describe('M1.5 — CSRF double-submit, over the wire with curl', () => {
  let ctx: AuthTestContext;
  let root = '';
  let base = '';
  let jarDir = '';

  /** Session A: the caller. */
  let tokenA = '';
  let csrfA = '';
  /** Session B: a second, concurrently valid login. */
  let tokenB = '';
  let csrfB = '';
  /** The pre-authentication pair session A held between the two login stages. */
  let preCsrf = '';
  let secret = '';
  const flow: Record<string, CurlResult> = {};

  async function post(
    path: string,
    opts: { jar?: string; cookie?: string; body?: unknown; csrf?: string; origin?: string } = {},
  ): Promise<CurlResult> {
    const args = ['-X', 'POST'];
    if (opts.jar !== undefined) args.push('-b', opts.jar, '-c', opts.jar);
    if (opts.cookie !== undefined) args.push('--cookie', opts.cookie);
    if (opts.body !== undefined) {
      args.push('-H', 'content-type: application/json', '--data-binary', JSON.stringify(opts.body));
    }
    if (opts.csrf !== undefined) args.push('-H', `${CSRF_HEADER}: ${opts.csrf}`);
    if (opts.origin !== undefined) args.push('-H', `Origin: ${opts.origin}`);
    args.push(`${base}${path}`);
    return curl(args);
  }

  beforeAll(async () => {
    ctx = await createAuthTestServer();
    root = await listenLoopback(ctx.app);
    base = `${root}${ctx.prefix}`;
    jarDir = mkdtempSync(join(tmpdir(), 'panel-csrf-jar-'));
    const jarA = join(jarDir, 'a.txt');
    const jarB = join(jarDir, 'b.txt');

    // ── Session A: password, enrol, confirm ──────────────────────────────────
    flow.login = await post('/api/auth/login', {
      jar: jarA,
      body: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    preCsrf = fromJar(jarA, CSRF_COOKIE);

    flow.enroll = await post('/api/auth/totp/enroll', { jar: jarA, csrf: preCsrf });
    secret = (JSON.parse(flow.enroll.body) as { secret: string }).secret;

    flow.verify = await post('/api/auth/totp/enroll/verify', {
      jar: jarA,
      body: { code: totpCodeAt(secret, ctx.clock.now()) },
      csrf: preCsrf,
    });
    tokenA = fromJar(jarA, SESSION_COOKIE);
    csrfA = fromJar(jarA, CSRF_COOKIE);

    // ── Session B: a second full login, so "another session's token" is real ──
    ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
    flow.loginB = await post('/api/auth/login', {
      jar: jarB,
      body: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    flow.totpB = await post('/api/auth/login/totp', {
      jar: jarB,
      body: { code: totpCodeAt(secret, ctx.clock.now()) },
      csrf: fromJar(jarB, CSRF_COOKIE),
    });
    tokenB = fromJar(jarB, SESSION_COOKIE);
    csrfB = fromJar(jarB, CSRF_COOKIE);
  });

  afterAll(async () => {
    if (jarDir !== '') rmSync(jarDir, { recursive: true, force: true });
    if (ctx !== undefined) await ctx.cleanup();
  });

  it('completes a real two-stage login with nothing but curl and a cookie jar', () => {
    expect(flow.login!.status, flow.login!.body).toBe(200);
    expect(flow.enroll!.status, flow.enroll!.body).toBe(200);
    expect(flow.verify!.status, flow.verify!.body).toBe(200);
    expect(flow.loginB!.status, flow.loginB!.body).toBe(200);
    expect(flow.totpB!.status, flow.totpB!.body).toBe(200);

    // Both halves arrived, and the token is bound to the session it was issued for.
    expect(tokenA).not.toBe('');
    expect(csrfA).toBe(csrfTokenFor(ctx.app.auth.sessions.resolve(tokenA)!.id, hashToken(tokenA)));

    // Rotation: promotion to `full` replaced the session token, so the CSRF token
    // the pre session was holding is dead. Nothing rotates it explicitly — it is
    // derived from the session token's hash, so it cannot fail to rotate.
    expect(csrfA).not.toBe(preCsrf);
    expect(csrfB).not.toBe(csrfA);
    expect(tokenB).not.toBe(tokenA);
  });

  it('rejects a mutating request with no X-CSRF-Token header', async () => {
    const res = await post('/api/sessions/revoke-others', {
      cookie: `${SESSION_COOKIE}=${tokenA}; ${CSRF_COOKIE}=${csrfA}`,
    });
    expect(res.status).toBe(403);
    // Nothing but the reason phrase: the hook's own message never reaches a client.
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden', code: 'csrf_invalid' });
  });

  it('rejects a mutating request whose header does not match the cookie', async () => {
    // Same length, same alphabet, one character different — so the rejection is
    // about the comparison and not about the shape.
    const flipped = `${csrfA.slice(0, -1)}${csrfA.endsWith('A') ? 'B' : 'A'}`;
    const res = await post('/api/sessions/revoke-others', {
      cookie: `${SESSION_COOKIE}=${tokenA}; ${CSRF_COOKIE}=${csrfA}`,
      csrf: flipped,
    });
    expect(res.status).toBe(403);
  });

  it('rejects a token minted for a different session', async () => {
    const res = await post('/api/sessions/revoke-others', {
      cookie: `${SESSION_COOKIE}=${tokenA}; ${CSRF_COOKIE}=${csrfA}`,
      csrf: csrfB,
    });
    expect(res.status).toBe(403);
  });

  it('rejects another session’s token even when its cookie and header agree', async () => {
    // The case a bare random double-submit cannot catch. An attacker who can write
    // a cookie for this host writes both halves and they match each other perfectly;
    // what they cannot do is make them match the session cookie being presented.
    const res = await post('/api/sessions/revoke-others', {
      cookie: `${SESSION_COOKIE}=${tokenA}; ${CSRF_COOKIE}=${csrfB}`,
      csrf: csrfB,
    });
    expect(res.status).toBe(403);
    expect(ctx.app.auth.sessions.resolve(tokenB)).not.toBeNull();
  });

  it('accepts the matching pair, and the request takes effect', async () => {
    const res = await post('/api/sessions/revoke-others', {
      cookie: `${SESSION_COOKIE}=${tokenA}; ${CSRF_COOKIE}=${csrfA}`,
      csrf: csrfA,
      // A loopback Origin, which is what a browser on this host would send. The
      // configured public origin is `http://localhost`, so this also exercises the
      // development loopback allowance in the Origin check.
      origin: root,
    });
    expect(res.status, res.body).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ revoked: 1 });
    // Proof it was not a no-op accepted for the wrong reason.
    expect(ctx.app.auth.sessions.resolve(tokenB)).toBeNull();
    expect(ctx.app.auth.sessions.resolve(tokenA)).not.toBeNull();
  });
});

/**
 * The exemptions and the rotation, through `inject`.
 *
 * These are about which requests the hook declines to police and when the token
 * changes underneath a client, neither of which needs a socket. The wire-level
 * proof is above.
 */
describe('M1.5 — what the CSRF check does not police, and when the token changes', () => {
  let ctx: AuthTestContext;

  afterAll(async () => {
    if (ctx !== undefined) await ctx.cleanup();
  });

  it('exempts safe methods, the login endpoint, and a request with no live session', async () => {
    ctx = await createAuthTestServer();
    const account = await enrollAccount(ctx);

    // A safe method with the session cookie and neither CSRF half.
    const read = await ctx.app.inject({
      method: 'GET',
      url: ctx.url('/api/auth/me'),
      cookies: { [SESSION_COOKIE]: account.cookie },
    });
    expect(read.statusCode).toBe(200);

    // Login: mutating, and deliberately exempt. There is no session to bind a
    // token to yet, and `SameSite=Strict` plus the Origin check already stop a
    // cross-site attempt at it.
    const login = await postLogin(ctx);
    expect(login.statusCode).toBe(200);

    // A cookie that resolves to nothing is not a session, so the CSRF hook passes
    // it through — and the route's own guard answers 401 rather than 403. The
    // distinction matters: a 403 here would tell an attacker their forged cookie
    // was at least recognised as one.
    const garbage = await ctx.app.inject({
      method: 'POST',
      url: ctx.url('/api/sessions/revoke-others'),
      cookies: { [SESSION_COOKIE]: 'not-a-real-token' },
    });
    expect(garbage.statusCode).toBe(401);
  });

  it('rejects a header with no cookie, and a cookie with no header', async () => {
    ctx = await createAuthTestServer();
    const account = await enrollAccount(ctx);
    const session = ctx.app.auth.sessions.resolve(account.cookie)!;
    const token = csrfTokenFor(session.id, hashToken(account.cookie));

    const headerOnly = await ctx.app.inject({
      method: 'POST',
      url: ctx.url('/api/sessions/revoke-others'),
      cookies: { [SESSION_COOKIE]: account.cookie },
      headers: { [CSRF_HEADER]: token },
    });
    expect(headerOnly.statusCode).toBe(403);

    const cookieOnly = await ctx.app.inject({
      method: 'POST',
      url: ctx.url('/api/sessions/revoke-others'),
      cookies: { [SESSION_COOKIE]: account.cookie, [CSRF_COOKIE]: token },
    });
    expect(cookieOnly.statusCode).toBe(403);

    // And both, which is the control for the two above.
    const both = await ctx.app.inject({
      method: 'POST',
      url: ctx.url('/api/sessions/revoke-others'),
      cookies: { [SESSION_COOKIE]: account.cookie, [CSRF_COOKIE]: token },
      headers: { [CSRF_HEADER]: token },
    });
    expect(both.statusCode).toBe(200);
  });

  it('rotates the token whenever the session token rotates', async () => {
    ctx = await createAuthTestServer();
    const account = await enrollAccount(ctx);

    const csrfOf = (res: { cookies: { name: string; value: string }[] }): string | null => {
      const cookie = res.cookies.find((c) => c.name === CSRF_COOKIE);
      return cookie === undefined || cookie.value === '' ? null : cookie.value;
    };

    // pre → full was covered over the wire above; here the same for a password
    // change, which is the other rotation point.
    const stepped = await ctx.inject({
      method: 'POST',
      url: ctx.url('/api/auth/step-up'),
      cookies: { [SESSION_COOKIE]: account.cookie },
      payload: {
        password: TEST_PASSWORD,
        code: totpCodeAt(account.secret, (ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000), ctx.clock.now())),
      },
    });
    expect(stepped.statusCode, stepped.body).toBe(200);

    const changed = await ctx.inject({
      method: 'POST',
      url: ctx.url('/api/security/password'),
      cookies: { [SESSION_COOKIE]: account.cookie },
      payload: { newPassword: 'an-entirely-different-passphrase' },
    });
    expect(changed.statusCode, changed.body).toBe(200);

    const newSessionToken = ctx.cookieFrom(changed)!;
    const newCsrf = csrfOf(changed)!;
    expect(newSessionToken).not.toBe(account.cookie);
    expect(newCsrf).not.toBe(csrfTokenFor(1, hashToken(account.cookie)));
    expect(newCsrf).toBe(
      csrfTokenFor(ctx.app.auth.sessions.resolve(newSessionToken)!.id, hashToken(newSessionToken)),
    );

    // The pair issued before the rotation is now worthless, even though the row it
    // was minted for still exists and kept its identity.
    const stale = await ctx.app.inject({
      method: 'POST',
      url: ctx.url('/api/sessions/revoke-others'),
      cookies: {
        [SESSION_COOKIE]: newSessionToken,
        [CSRF_COOKIE]: csrfTokenFor(1, hashToken(account.cookie)),
      },
      headers: { [CSRF_HEADER]: csrfTokenFor(1, hashToken(account.cookie)) },
    });
    expect(stale.statusCode).toBe(403);
  });

  it('binds the token to the session id as well as to the token hash', async () => {
    // A unit-level statement of the property the wire test proves end to end: the
    // same session token hash under a different row id derives a different value,
    // so a token cannot be carried between rows even in the impossible case of two
    // rows sharing a token.
    ctx = await createAuthTestServer();
    const hash = hashToken('abcdef');
    expect(csrfTokenFor(1, hash)).not.toBe(csrfTokenFor(2, hash));
    expect(csrfTokenFor(1, hash)).toBe(csrfTokenFor(1, hash));
  });

  it('keeps a second login working until it is deliberately revoked', async () => {
    // The premise the "different session" rejection rests on: two full sessions
    // coexist, so a token from one really is a token from a live other session.
    ctx = await createAuthTestServer();
    const account = await enrollAccount(ctx);
    const second = await loginFully(ctx, account.secret);

    expect(ctx.app.auth.sessions.resolve(account.cookie)).not.toBeNull();
    expect(ctx.app.auth.sessions.resolve(second.cookie)).not.toBeNull();
    expect(ctx.app.auth.sessions.list()).toHaveLength(2);
  });
});
