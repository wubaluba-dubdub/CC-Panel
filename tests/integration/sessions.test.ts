import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { Response as InjectResponse } from 'light-my-request';
import { getDb } from '../../src/server/db.js';
import {
  ABSOLUTE_LIFETIME_MS,
  IDLE_TIMEOUT_MS,
  PRE_AUTH_LIFETIME_MS,
  STEP_UP_WINDOW_MS,
} from '../../src/server/services/session.service.js';
import { TOTP_PERIOD_SECONDS } from '../../src/server/services/totp.service.js';
import { AuditEvent } from '../../src/server/services/audit.service.js';
import {
  SESSION_COOKIE,
  TEST_PASSWORD,
  createAuthTestServer,
  enrollAccount,
  loginFully,
  postLogin,
  stepUp,
  totpCodeAt,
  type AuthTestContext,
} from '../helpers/auth-harness.js';

const HOUR = 60 * 60 * 1000;

describe('M1.4 — sessions and step-up', () => {
  let ctx: AuthTestContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  // ── The cookie ─────────────────────────────────────────────────────────────

  describe('Set-Cookie', () => {
    it('carries HttpOnly, SameSite=Strict, the base path, and no Domain', async () => {
      ctx = await createAuthTestServer();
      const login = await postLogin(ctx);

      const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE);
      expect(cookie, 'the session cookie was set').toBeDefined();

      expect(cookie!.name).toBe('panel_session');
      expect(cookie!.httpOnly).toBe(true);
      expect(cookie!.sameSite).toBe('Strict');
      expect(cookie!.path).toBe(`/${ctx.prefix.slice(1)}`);
      expect(cookie!.path).toBe('/authtest');
      expect('domain' in cookie!).toBe(false);

      // `Secure` and the `__Secure-` name prefix are the https profile, and the
      // test harness serves a loopback http origin — which is the whole reason the
      // profile exists. Both spellings are pinned in
      // `tests/integration/cookies.test.ts` against a configured https origin.
      expect(cookie!.secure).toBeUndefined();

      // And the same read straight off the raw header, in case the parser is
      // forgiving about something a browser would not be.
      const raw = login.headers['set-cookie'];
      const header = Array.isArray(raw) ? raw.join('\n') : String(raw);
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Strict');
      expect(header).toContain('Path=/authtest');
      expect(header).not.toContain('Domain');
      expect(header).not.toContain('Secure');
    });

    it('keeps every attribute when the session is promoted and when it rotates', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      const relogin = await loginFully(ctx, account.secret);

      for (const res of [relogin.response]) {
        const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
        expect(cookie.httpOnly).toBe(true);
        expect(cookie.secure).toBeUndefined();
        expect(cookie.sameSite).toBe('Strict');
        expect(cookie.path).toBe('/authtest');
        expect('domain' in cookie).toBe(false);
      }
    });

    it('is cleared on logout', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);

      const logout = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/logout'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      expect(logout.statusCode).toBe(204);
      expect(ctx.clearedCookie(logout)).toBe(true);

      // And the token is dead, not merely forgotten by the browser.
      const after = await ctx.app.inject({
        method: 'GET',
        url: ctx.url('/api/auth/me'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      expect(after.statusCode).toBe(401);
      expect(sessionCount()).toBe(0);
    });
  });

  // ── Rotation ───────────────────────────────────────────────────────────────

  describe('token rotation on privilege change', () => {
    it('changes the token when the second factor is accepted', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);

      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
      const login = await postLogin(ctx);
      const pre = ctx.cookieFrom(login)!;

      const promoted = await loginFullyFrom(ctx, pre, account.secret);
      const full = ctx.cookieFrom(promoted)!;

      expect(full).not.toBe(pre);
      // The old value stops working immediately.
      const withOld = await ctx.app.inject({
        method: 'GET',
        url: ctx.url('/api/auth/me'),
        cookies: { [SESSION_COOKIE]: pre },
      });
      expect(withOld.statusCode).toBe(401);
    });

    it('changes the token when the password changes', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      const granted = await stepUp(ctx, account.cookie, account.secret);
      expect(granted.statusCode).toBe(200);

      const changed = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/security/password'),
        cookies: { [SESSION_COOKIE]: account.cookie },
        payload: { newPassword: 'a-brand-new-strong-password' },
      });
      expect(changed.statusCode).toBe(200);

      const rotated = ctx.cookieFrom(changed);
      expect(rotated).not.toBeNull();
      expect(rotated).not.toBe(account.cookie);

      // The pre-change cookie is dead; the rotated one works.
      const withOld = await ctx.app.inject({
        method: 'GET',
        url: ctx.url('/api/auth/me'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      expect(withOld.statusCode).toBe(401);

      const withNew = await ctx.app.inject({
        method: 'GET',
        url: ctx.url('/api/auth/me'),
        cookies: { [SESSION_COOKIE]: rotated! },
      });
      expect(withNew.statusCode).toBe(200);

      // The new password is the one that works now.
      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
      expect((await postLogin(ctx, { password: TEST_PASSWORD })).statusCode).toBe(401);
      expect(
        (await postLogin(ctx, { password: 'a-brand-new-strong-password' })).statusCode,
      ).toBe(200);

      expect(auditEvents()).toContain(AuditEvent.PasswordChanged);
    });

    it('keeps the session row, so the list and revoke-others stay coherent', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      const before = sessionIds();

      await stepUp(ctx, account.cookie, account.secret);
      await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/security/password'),
        cookies: { [SESSION_COOKIE]: account.cookie },
        payload: { newPassword: 'another-strong-password-1' },
      });

      expect(sessionIds()).toEqual(before);
    });
  });

  // ── Expiry ─────────────────────────────────────────────────────────────────

  describe('expiry', () => {
    it('slides the idle deadline on use, and expires after eight idle hours', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      expect(IDLE_TIMEOUT_MS).toBe(8 * HOUR);

      // Seven hours of quiet, then a request: still alive, and the deadline moves.
      ctx.clock.advance(7 * HOUR);
      const alive = await me(ctx, account.cookie);
      expect(alive.statusCode).toBe(200);

      // Another seven hours — fourteen since login, but only seven since use.
      ctx.clock.advance(7 * HOUR);
      expect((await me(ctx, account.cookie)).statusCode).toBe(200);

      // Now go quiet for longer than the idle window.
      ctx.clock.advance(IDLE_TIMEOUT_MS + 1_000);
      expect((await me(ctx, account.cookie)).statusCode).toBe(401);
      // And the dead row is gone rather than lingering.
      expect(sessionCount()).toBe(0);
    });

    it('expires at the thirty-day absolute deadline however active the session is', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      expect(ABSOLUTE_LIFETIME_MS).toBe(30 * 24 * HOUR);

      // Use it every seven hours, so the idle deadline never lapses.
      for (let elapsed = 0; elapsed < ABSOLUTE_LIFETIME_MS - 7 * HOUR; elapsed += 7 * HOUR) {
        ctx.clock.advance(7 * HOUR);
        expect((await me(ctx, account.cookie)).statusCode, `at ${elapsed / HOUR}h`).toBe(200);
      }

      // Past thirty days it is over regardless.
      ctx.clock.advance(8 * HOUR);
      expect((await me(ctx, account.cookie)).statusCode).toBe(401);
    });

    it('never slides the idle deadline past the absolute one', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);

      // Stay active — in seven-hour steps, inside the eight-hour idle window —
      // until an hour before the absolute deadline. Jumping straight there would
      // trip the idle timeout instead and prove nothing about the clamp.
      const absolute = Date.parse(absoluteDeadline());
      while (ctx.clock.now() < absolute - 8 * HOUR) {
        ctx.clock.advance(7 * HOUR);
        expect((await me(ctx, account.cookie)).statusCode).toBe(200);
      }

      const row = getDb()
        .prepare('SELECT expires_at, absolute_expires_at FROM sessions LIMIT 1')
        .get() as { expires_at: string; absolute_expires_at: string };

      // The idle deadline would be now + 8h, which is past the absolute one.
      expect(ctx.clock.now() + IDLE_TIMEOUT_MS).toBeGreaterThan(
        Date.parse(row.absolute_expires_at),
      );
      expect(Date.parse(row.expires_at)).toBe(Date.parse(row.absolute_expires_at));
    });

    it('gives the pre-auth session five minutes and no sliding', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      expect(PRE_AUTH_LIFETIME_MS).toBe(5 * 60 * 1000);

      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
      const login = await postLogin(ctx);
      const pre = ctx.cookieFrom(login)!;

      // Four minutes in, still usable, and using it does not extend it.
      ctx.clock.advance(4 * 60 * 1000);
      expect((await me(ctx, pre)).statusCode).toBe(200);

      ctx.clock.advance(90 * 1000);
      expect((await me(ctx, pre)).statusCode).toBe(401);
      void account;
    });
  });

  // ── Listing and revocation ─────────────────────────────────────────────────

  describe('listing and revocation', () => {
    it('lists every session, flags the current one, and shows display-only metadata', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      const second = await loginFully(ctx, account.secret);

      const list = await ctx.app.inject({
        method: 'GET',
        url: ctx.url('/api/sessions'),
        cookies: { [SESSION_COOKIE]: second.cookie },
        headers: { 'user-agent': 'test-agent/1.0' },
      });
      expect(list.statusCode).toBe(200);

      const { sessions } = list.json() as {
        sessions: { id: number; current: boolean; ip: string | null; userAgent: string | null }[];
      };
      expect(sessions).toHaveLength(2);
      expect(sessions.filter((s) => s.current)).toHaveLength(1);
      // Present, and recorded from the request rather than invented.
      expect(sessions.every((s) => 'ip' in s && 'userAgent' in s)).toBe(true);
      // No token, hashed or otherwise, in the listing.
      expect(JSON.stringify(sessions)).not.toContain('token');
    });

    it('revoke-others keeps the caller working and kills the rest', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      const second = await loginFully(ctx, account.secret);
      const third = await loginFully(ctx, account.secret);
      expect(sessionCount()).toBe(3);

      const revoked = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/sessions/revoke-others'),
        cookies: { [SESSION_COOKIE]: third.cookie },
      });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json()).toEqual({ revoked: 2 });

      // The caller survives.
      expect((await me(ctx, third.cookie)).statusCode).toBe(200);
      // The others do not.
      expect((await me(ctx, account.cookie)).statusCode).toBe(401);
      expect((await me(ctx, second.cookie)).statusCode).toBe(401);
      expect(sessionCount()).toBe(1);
    });

    it('revokes one by id, and clears the cookie when it is the caller', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      const second = await loginFully(ctx, account.secret);

      const ids = sessionIds();
      const other = ids.find((id) => id !== currentSessionId(second.cookie))!;

      const dropOther = await ctx.app.inject({
        method: 'DELETE',
        url: ctx.url(`/api/sessions/${other}`),
        cookies: { [SESSION_COOKIE]: second.cookie },
      });
      expect(dropOther.statusCode).toBe(204);
      expect(ctx.clearedCookie(dropOther)).toBe(false);
      expect((await me(ctx, second.cookie)).statusCode).toBe(200);

      // Revoking your own behaves as a logout, cookie cleared.
      const own = currentSessionId(second.cookie);
      const dropSelf = await ctx.app.inject({
        method: 'DELETE',
        url: ctx.url(`/api/sessions/${own}`),
        cookies: { [SESSION_COOKIE]: second.cookie },
      });
      expect(dropSelf.statusCode).toBe(204);
      expect(ctx.clearedCookie(dropSelf)).toBe(true);
      expect((await me(ctx, second.cookie)).statusCode).toBe(401);
    });

    it('404s on a session that is not there', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);

      const res = await ctx.app.inject({
        method: 'DELETE',
        url: ctx.url('/api/sessions/99999'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe('{"error":"Not Found"}');
    });
  });

  // ── Step-up ────────────────────────────────────────────────────────────────

  describe('step-up re-authentication', () => {
    it('requires both the password and a code, and lasts five minutes', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      expect(STEP_UP_WINDOW_MS).toBe(5 * 60 * 1000);

      const granted = await stepUp(ctx, account.cookie, account.secret);
      expect(granted.statusCode).toBe(200);
      const { stepUpUntil } = granted.json() as { stepUpUntil: string };
      expect(Date.parse(stepUpUntil) - ctx.clock.now()).toBe(STEP_UP_WINDOW_MS);

      expect((await me(ctx, account.cookie)).json()).toMatchObject({ stepUpActive: true });
      expect(auditEvents()).toContain(AuditEvent.StepUpGranted);

      // Four minutes: still good.
      ctx.clock.advance(4 * 60 * 1000);
      expect(await recoveryCodesStatus(ctx, account.cookie)).toBe(200);

      // Six minutes from the grant: gone.
      ctx.clock.advance(2 * 60 * 1000);
      expect(await recoveryCodesStatus(ctx, account.cookie)).toBe(403);
    });

    it('refuses a wrong password or a wrong code, and counts the failure', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      const before = failureCount();

      const wrongPassword = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/step-up'),
        cookies: { [SESSION_COOKIE]: account.cookie },
        payload: { password: 'not-the-password', code: '000000' },
      });
      expect(wrongPassword.statusCode).toBe(401);
      expect(failureCount()).toBe(before + 1);

      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
      const wrongCode = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/step-up'),
        cookies: { [SESSION_COOKIE]: account.cookie },
        payload: { password: TEST_PASSWORD, code: '000000' },
      });
      expect(wrongCode.statusCode).toBe(401);
      expect(failureCount()).toBe(before + 2);

      // No step-up was granted by either.
      expect((await me(ctx, account.cookie)).json()).toMatchObject({ stepUpActive: false });
    });

    it('is scoped to the session that earned it', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      const second = await loginFully(ctx, account.secret);

      const granted = await stepUp(ctx, second.cookie, account.secret);
      expect(granted.statusCode).toBe(200);

      expect(await recoveryCodesStatus(ctx, second.cookie)).toBe(200);
      // The other session did not inherit it.
      expect(await recoveryCodesStatus(ctx, account.cookie)).toBe(403);
    });
  });

  // ── What step-up gates ─────────────────────────────────────────────────────

  describe('privileged operations', () => {
    it('rejects every one of them without a step-up', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);

      const attempts: [string, Record<string, unknown>][] = [
        ['/api/security/password', { newPassword: 'a-strong-enough-password' }],
        ['/api/security/recovery-codes', {}],
        ['/api/security/2fa/disable', {}],
        ['/api/security/base-path/regenerate', {}],
        ['/api/secrets/reveal', { scope: 'global', name: 'token' }],
      ];

      for (const [path, payload] of attempts) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: ctx.url(path),
          cookies: { [SESSION_COOKIE]: account.cookie },
          payload,
        });
        expect(res.statusCode, path).toBe(403);
        expect(res.body, path).toBe('{"error":"Forbidden"}');
      }

      const put = await ctx.app.inject({
        method: 'PUT',
        url: ctx.url('/api/secrets'),
        cookies: { [SESSION_COOKIE]: account.cookie },
        payload: { scope: 'global', name: 'token', value: 'whatever' },
      });
      expect(put.statusCode).toBe(403);

      // Nothing happened: the password still works and 2FA is still on.
      expect((await me(ctx, account.cookie)).json()).toMatchObject({ totpEnabled: true });
    });

    it('allows them with one, and rejects a weak new password', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      await stepUp(ctx, account.cookie, account.secret);

      const weak = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/security/password'),
        cookies: { [SESSION_COOKIE]: account.cookie },
        payload: { newPassword: 'short' },
      });
      expect(weak.statusCode).toBe(400);

      const known = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/security/password'),
        cookies: { [SESSION_COOKIE]: account.cookie },
        payload: { newPassword: 'password123456' },
      });
      expect(known.statusCode).toBe(400);
      expect(known.body).toBe('{"error":"Bad Request"}');
    });

    it('regenerates recovery codes, invalidating the old set', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      await stepUp(ctx, account.cookie, account.secret);

      const res = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/security/recovery-codes'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      expect(res.statusCode).toBe(200);
      const { recoveryCodes } = res.json() as { recoveryCodes: string[] };
      expect(recoveryCodes).toHaveLength(10);
      expect(new Set(recoveryCodes)).not.toEqual(new Set(account.recoveryCodes));

      // An old code no longer logs anyone in.
      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
      const login = await postLogin(ctx);
      const withOld = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login/totp'),
        cookies: { [SESSION_COOKIE]: ctx.cookieFrom(login)! },
        payload: { code: account.recoveryCodes[0]! },
      });
      expect(withOld.statusCode).toBe(401);
    });

    it('disables two-factor and takes the recovery codes with it', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      await stepUp(ctx, account.cookie, account.secret);

      const res = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/security/2fa/disable'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      expect(res.statusCode).toBe(204);

      const state = (await me(ctx, account.cookie)).json() as {
        totpEnabled: boolean;
        recoveryCodesRemaining: number;
      };
      expect(state.totpEnabled).toBe(false);
      expect(state.recoveryCodesRemaining).toBe(0);
      expect(auditEvents()).toContain(AuditEvent.TwoFactorDisabled);

      // Login now lands on setup rather than on a code prompt.
      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
      expect((await postLogin(ctx)).json()).toEqual({ stage: 'setup' });
    });

    it('refuses base-path regeneration while PANEL_BASE_PATH is set, and does it otherwise', async () => {
      ctx = await createAuthTestServer();
      const pinned = await enrollAccount(ctx);
      await stepUp(ctx, pinned.cookie, pinned.secret);

      // The harness pins PANEL_BASE_PATH, which wins on every boot, so writing a
      // new instance.json would be silently ignored.
      const refused = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/security/base-path/regenerate'),
        cookies: { [SESSION_COOKIE]: pinned.cookie },
      });
      expect(refused.statusCode).toBe(409);
      await ctx.cleanup();

      // Without it, regeneration writes a new prefix and says a restart is needed.
      ctx = await createAuthTestServer({ PANEL_BASE_PATH: undefined });
      const generated = ctx.app.basePath;
      expect(ctx.prefix).toBe(`/${generated}`);

      const account = await enrollAccount(ctx);
      await stepUp(ctx, account.cookie, account.secret);

      const done = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/security/base-path/regenerate'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      expect(done.statusCode).toBe(200);
      const body = done.json() as { basePath: string; restartRequired: boolean };
      expect(body.restartRequired).toBe(true);
      expect(body.basePath).toHaveLength(22);
      expect(body.basePath).not.toBe(generated);
      // The running server still answers on the old prefix, as advertised.
      expect((await ctx.app.inject({ method: 'GET', url: `/${generated}/` })).statusCode).toBe(200);
      expect(auditEvents()).toContain(AuditEvent.BasePathRegenerated);
    });

    it('reveals and rotates a stored secret only with a step-up', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      await stepUp(ctx, account.cookie, account.secret);

      const set = await ctx.app.inject({
        method: 'PUT',
        url: ctx.url('/api/secrets'),
        cookies: { [SESSION_COOKIE]: account.cookie },
        payload: { scope: 'global', name: 'anthropic_auth_token', value: 'opaque-value-12345' },
      });
      expect(set.statusCode).toBe(204);

      const list = await ctx.app.inject({
        method: 'GET',
        url: ctx.url('/api/secrets'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      expect(list.statusCode).toBe(200);
      // Metadata only — the value is not in the listing.
      expect(list.body).not.toContain('opaque-value-12345');

      const reveal = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/secrets/reveal'),
        cookies: { [SESSION_COOKIE]: account.cookie },
        payload: { scope: 'global', name: 'anthropic_auth_token' },
      });
      expect(reveal.statusCode).toBe(200);
      expect(reveal.json()).toEqual({
        scope: 'global',
        name: 'anthropic_auth_token',
        value: 'opaque-value-12345',
      });

      const events = auditEvents();
      expect(events).toContain(AuditEvent.SecretChanged);
      expect(events).toContain(AuditEvent.SecretRevealed);
      // Not the value, in either row.
      expect(JSON.stringify(auditRows())).not.toContain('opaque-value-12345');
    });
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function me(ctx: AuthTestContext, cookie: string): Promise<InjectResponse> {
  return ctx.app.inject({
    method: 'GET',
    url: ctx.url('/api/auth/me'),
    cookies: { [SESSION_COOKIE]: cookie },
  });
}

async function recoveryCodesStatus(ctx: AuthTestContext, cookie: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: ctx.url('/api/security/recovery-codes'),
    cookies: { [SESSION_COOKIE]: cookie },
  });
  return res.statusCode;
}

function loginFullyFrom(
  ctx: AuthTestContext,
  preCookie: string,
  secret: string,
): Promise<InjectResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: ctx.url('/api/auth/login/totp'),
    cookies: { [SESSION_COOKIE]: preCookie },
    payload: { code: totpCodeAt(secret, ctx.clock.now()) },
  });
}

function currentSessionId(cookie: string): number {
  const hash = createHash('sha256').update(cookie, 'utf8').digest('hex');
  const row = getDb().prepare('SELECT id FROM sessions WHERE token_hash = ?').get(hash) as
    | { id: number }
    | undefined;
  if (row === undefined) throw new Error('cookie does not match a session');
  return row.id;
}

function sessionCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
}

function absoluteDeadline(): string {
  return (
    getDb().prepare('SELECT absolute_expires_at AS a FROM sessions LIMIT 1').get() as {
      a: string;
    }
  ).a;
}

function sessionIds(): number[] {
  return (getDb().prepare('SELECT id FROM sessions ORDER BY id').all() as { id: number }[]).map(
    (r) => r.id,
  );
}

function failureCount(): number {
  return (
    getDb()
      .prepare('SELECT consecutive_failures AS c FROM auth_failures WHERE id = 1')
      .get() as { c: number }
  ).c;
}

function auditRows(): { event: string; meta: Record<string, unknown> }[] {
  return (
    getDb().prepare('SELECT event, meta_json FROM audit_log ORDER BY id').all() as {
      event: string;
      meta_json: string;
    }[]
  ).map((r) => ({ event: r.event, meta: JSON.parse(r.meta_json) as Record<string, unknown> }));
}

function auditEvents(): string[] {
  return auditRows().map((r) => r.event);
}
