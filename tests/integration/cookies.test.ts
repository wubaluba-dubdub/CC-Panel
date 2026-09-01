import { describe, it, expect, afterEach } from 'vitest';
import type { Response as InjectResponse } from 'light-my-request';
import { getDb } from '../../src/server/db.js';
import {
  COOKIE_BASE_NAMES,
  SECURE_PREFIX,
  cookieMaxAgeSeconds,
  cookieProfileFor,
} from '../../src/server/plugins/cookies.js';
import {
  ABSOLUTE_LIFETIME_MS,
  IDLE_TIMEOUT_MS,
  PRE_AUTH_LIFETIME_MS,
  type SessionRecord,
} from '../../src/server/services/session.service.js';
import { resolvePublicOrigin, type PublicOrigin } from '../../src/server/utils/public-origin.js';
import { isoFrom } from '../../src/server/utils/clock.js';
import { createTestServer, makeTestEnv, type TestContext } from '../helpers/test-server.js';
import {
  SESSION_COOKIE,
  createAuthTestServer,
  enrollAccount,
  loginFully,
  postLogin,
  type AuthTestContext,
} from '../helpers/auth-harness.js';

const PROD_URL = 'https://panel.example';

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 1,
    authLevel: 'full',
    createdAt: isoFrom(0),
    lastSeenAt: isoFrom(0),
    expiresAt: isoFrom(IDLE_TIMEOUT_MS),
    absoluteExpiresAt: isoFrom(ABSOLUTE_LIFETIME_MS),
    ip: null,
    userAgent: null,
    stepUpUntil: null,
    ...over,
  };
}

function origin(over: Partial<PublicOrigin> = {}): PublicOrigin {
  return {
    origin: 'http://127.0.0.1:3000',
    protocol: 'http',
    host: '127.0.0.1:3000',
    hostname: '127.0.0.1',
    secure: false,
    loopback: true,
    source: 'development-fallback',
    ...over,
  };
}

describe('M1.5 part 0 — the cookie profile follows the public origin', () => {
  let ctx: TestContext | AuthTestContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  describe('the https profile', () => {
    it('prefixes the name and sets Secure when the public origin is https', async () => {
      const authCtx = await createAuthTestServer({ PANEL_PUBLIC_URL: PROD_URL });
      ctx = authCtx;

      expect(authCtx.app.auth.cookies.sessionName).toBe(`${SECURE_PREFIX}panel_session`);
      expect(authCtx.app.auth.cookies.csrfName).toBe(`${SECURE_PREFIX}panel_csrf`);

      const login = await postLogin(authCtx);
      const cookie = login.cookies.find((c) => c.name === `${SECURE_PREFIX}panel_session`);
      expect(cookie, 'the prefixed cookie was set').toBeDefined();
      expect(cookie!.secure).toBe(true);
      expect(cookie!.httpOnly).toBe(true);
      expect(cookie!.sameSite).toBe('Strict');
      expect(cookie!.path).toBe(`/${authCtx.app.basePath}`);

      const raw = login.headers['set-cookie'];
      const header = Array.isArray(raw) ? raw.join('\n') : String(raw);
      expect(header).toContain(`${SECURE_PREFIX}panel_session=`);
      expect(header).toContain('Secure');
    });

    it('is what production boots with, and production boots', async () => {
      ctx = await createTestServer({
        PANEL_BASE_PATH: 'x',
        NODE_ENV: 'production',
        PANEL_PUBLIC_URL: PROD_URL,
      });
      expect(ctx.app.auth.cookies.profile).toEqual({ secure: true, prefix: SECURE_PREFIX });
      expect(ctx.app.publicOrigin.origin).toBe(PROD_URL);
    });

    it('takes RAILWAY_PUBLIC_DOMAIN as https when PANEL_PUBLIC_URL is absent', async () => {
      ctx = await createTestServer({
        PANEL_BASE_PATH: 'x',
        NODE_ENV: 'production',
        RAILWAY_PUBLIC_DOMAIN: 'cc-panel.up.railway.app',
      });
      expect(ctx.app.publicOrigin.origin).toBe('https://cc-panel.up.railway.app');
      expect(ctx.app.auth.cookies.profile.secure).toBe(true);
    });
  });

  describe('the loopback development profile', () => {
    it('drops the prefix and Secure so Chrome will accept the cookie over http', async () => {
      const authCtx = await createAuthTestServer();
      ctx = authCtx;

      expect(authCtx.app.auth.cookies.profile).toEqual({ secure: false, prefix: '' });
      expect(authCtx.app.auth.cookies.sessionName).toBe(COOKIE_BASE_NAMES.session);

      const login = await postLogin(authCtx);
      const raw = login.headers['set-cookie'];
      const header = Array.isArray(raw) ? raw.join('\n') : String(raw);
      expect(header).not.toContain(SECURE_PREFIX);
      expect(header).not.toContain('Secure');
      // Everything else the profile does *not* relax.
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Strict');
    });

    it('still issues the CSRF cookie, readable by script, with the same scope', async () => {
      const authCtx = await createAuthTestServer();
      ctx = authCtx;
      const login = await postLogin(authCtx);

      const csrf = login.cookies.find((c) => c.name === COOKIE_BASE_NAMES.csrf);
      expect(csrf, 'the CSRF cookie was set alongside the session cookie').toBeDefined();
      // A double-submit token the client has to read, so this one cannot be HttpOnly.
      expect(csrf!.httpOnly).toBeUndefined();
      expect(csrf!.sameSite).toBe('Strict');
      expect(csrf!.path).toBe(`/${authCtx.app.basePath}`);
    });
  });

  // ── The guard: two independent refusals ──────────────────────────────────────
  //
  // `resolvePublicOrigin` refuses at boot; `cookieProfileFor` refuses again at the
  // point of choosing the profile. Deleting either one leaves the other failing a
  // test, which is what makes the mutation check meaningful rather than decorative.
  describe('the production guard', () => {
    it('refuses to boot in production with an http public URL', async () => {
      await expect(
        createTestServer({
          PANEL_BASE_PATH: 'x',
          NODE_ENV: 'production',
          PANEL_PUBLIC_URL: 'http://panel.example',
        }),
      ).rejects.toThrow(/not https.*NODE_ENV=production|Refusing to start/s);
    });

    it('refuses to boot in production with no public URL configured at all', async () => {
      await expect(
        createTestServer({ PANEL_BASE_PATH: 'x', NODE_ENV: 'production' }),
      ).rejects.toThrow(/PANEL_PUBLIC_URL/);
    });

    it('refuses a non-loopback http origin even outside production', () => {
      const env = makeTestEnv({ PANEL_PUBLIC_URL: 'http://panel.example' });
      expect(() => resolvePublicOrigin(env)).toThrow(/non-loopback host/);
    });

    it('refuses the development profile outright when NODE_ENV=production', () => {
      // The second guard, reached directly with a loopback http origin that
      // `resolvePublicOrigin` would never have returned in production. This is the
      // branch the prompt requires be unreachable in production.
      expect(() => cookieProfileFor(origin(), 'production')).toThrow(
        /refusing to issue a non-Secure session cookie with NODE_ENV=production/,
      );
      expect(cookieProfileFor(origin(), 'development')).toEqual({ secure: false, prefix: '' });
    });

    it('refuses the development profile for a non-loopback http origin at any NODE_ENV', () => {
      const routable = origin({
        origin: 'http://panel.example',
        host: 'panel.example',
        hostname: 'panel.example',
        loopback: false,
      });
      for (const nodeEnv of ['development', 'test']) {
        expect(() => cookieProfileFor(routable, nodeEnv), nodeEnv).toThrow(/non-loopback origin/);
      }
    });

    it('never returns an unprefixed name together with Secure, or the reverse', () => {
      // The prefix and the attribute are one decision. A profile with one and not
      // the other is exactly the state that made the cookie silently unusable.
      for (const [o, env] of [
        [origin(), 'development'],
        [origin({ origin: PROD_URL, protocol: 'https', host: 'panel.example', hostname: 'panel.example', secure: true, loopback: false }), 'production'],
      ] as const) {
        const profile = cookieProfileFor(o, env);
        expect(profile.secure).toBe(profile.prefix === SECURE_PREFIX);
      }
    });
  });

  // ── Lifetime ────────────────────────────────────────────────────────────────
  describe('Max-Age', () => {
    it('mirrors the sliding idle window for each level', () => {
      expect(cookieMaxAgeSeconds(session(), 0)).toBe(IDLE_TIMEOUT_MS / 1000);
      expect(
        cookieMaxAgeSeconds(
          session({ authLevel: 'pre', absoluteExpiresAt: isoFrom(PRE_AUTH_LIFETIME_MS) }),
          0,
        ),
      ).toBe(PRE_AUTH_LIFETIME_MS / 1000);
    });

    it('never exceeds what is left of the absolute lifetime', () => {
      // A full session 30 days minus 10 minutes old: the idle window is 8 hours,
      // but the session has 10 minutes to live.
      const nowMs = ABSOLUTE_LIFETIME_MS - 10 * 60 * 1000;
      expect(cookieMaxAgeSeconds(session(), nowMs)).toBe(600);
      // And never beyond the absolute limit, from any starting point.
      for (const at of [0, 1_000, ABSOLUTE_LIFETIME_MS / 2, ABSOLUTE_LIFETIME_MS - 1]) {
        expect(cookieMaxAgeSeconds(session(), at)).toBeLessThanOrEqual(
          ABSOLUTE_LIFETIME_MS / 1000,
        );
      }
    });

    it('is at least one second, so it is never read as a delete instruction', () => {
      expect(cookieMaxAgeSeconds(session(), ABSOLUTE_LIFETIME_MS)).toBe(1);
      expect(cookieMaxAgeSeconds(session(), ABSOLUTE_LIFETIME_MS + 60_000)).toBe(1);
      // An unreadable absolute deadline falls back to the idle window rather than
      // to NaN, which serialises as a missing attribute.
      expect(cookieMaxAgeSeconds(session({ absoluteExpiresAt: null }), 0)).toBe(
        IDLE_TIMEOUT_MS / 1000,
      );
    });

    it('is set on the wire, five minutes for a pre session and eight hours once full', async () => {
      const authCtx = await createAuthTestServer();
      ctx = authCtx;

      const login = await postLogin(authCtx);
      expect(maxAgeOf(login.cookies, SESSION_COOKIE)).toBe(PRE_AUTH_LIFETIME_MS / 1000);

      const account = await enrollAccount(authCtx);
      const full = await loginFully(authCtx, account.secret);
      expect(maxAgeOf(full.response.cookies, SESSION_COOKIE)).toBe(IDLE_TIMEOUT_MS / 1000);
    });

    it('is re-stamped on an authenticated request, tracking the slid deadline', async () => {
      const authCtx = await createAuthTestServer();
      ctx = authCtx;
      const account = await enrollAccount(authCtx);

      // Two hours later the server slides the idle deadline on use; without the
      // refresh the browser would still hold the Max-Age issued at enrolment and
      // drop the cookie two hours early.
      authCtx.clock.advance(2 * 60 * 60 * 1000);
      const me = await authCtx.inject({
        method: 'GET',
        url: authCtx.url('/api/auth/me'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      expect(me.statusCode).toBe(200);
      expect(maxAgeOf(me.cookies, SESSION_COOKIE)).toBe(IDLE_TIMEOUT_MS / 1000);
      // The value is unchanged — a refresh is not a rotation.
      expect(authCtx.cookieFrom(me)).toBe(account.cookie);
    });

    it('is clamped on the wire when the row is near its absolute deadline', async () => {
      const authCtx = await createAuthTestServer();
      ctx = authCtx;
      const account = await enrollAccount(authCtx);

      // The row is the authority on the deadline, so move it rather than spending
      // thirty days of injected requests to get there.
      const tenMinutes = isoFrom(authCtx.clock.now() + 10 * 60 * 1000);
      getDb().prepare('UPDATE sessions SET absolute_expires_at = ?').run(tenMinutes);

      const me = await authCtx.inject({
        method: 'GET',
        url: authCtx.url('/api/auth/me'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      expect(me.statusCode).toBe(200);
      const maxAge = maxAgeOf(me.cookies, SESSION_COOKIE)!;
      expect(maxAge).toBeLessThanOrEqual(600);
      expect(maxAge).toBeGreaterThan(0);
    });

    it('does not overwrite a rotation or a logout with the old value', async () => {
      const authCtx = await createAuthTestServer();
      ctx = authCtx;
      const account = await enrollAccount(authCtx);

      // The refresh hook runs on every authenticated response, including the ones
      // that deliberately replaced the cookie. Exactly one Set-Cookie for the
      // session name, and it is the new token.
      const logout = await authCtx.inject({
        method: 'POST',
        url: authCtx.url('/api/auth/logout'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      const sessionCookies = logout.cookies.filter((c) => c.name === SESSION_COOKIE);
      expect(sessionCookies).toHaveLength(1);
      expect(authCtx.clearedCookie(logout)).toBe(true);
    });
  });
});

function maxAgeOf(cookies: InjectResponse['cookies'], name: string): number | undefined {
  const cookie = cookies.find((c) => c.name === name);
  return cookie?.maxAge;
}
