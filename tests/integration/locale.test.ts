import { describe, it, expect, afterEach } from 'vitest';
import {
  SESSION_COOKIE,
  createAuthTestServer,
  enrollAccount,
  postLogin,
  type AuthTestContext,
} from '../helpers/auth-harness.js';
import { getDb } from '../../src/server/db.js';
import type { LocaleResponse, MeResponse } from '../../src/shared/types.js';

/**
 * The one language decision the server makes, and the one it stores.
 *
 * Two separate things, and keeping them separate is the design: `bootstrap.js` *guesses* from
 * `Accept-Language` on an unauthenticated route with no database read, and `PATCH
 * /api/settings/locale` *stores* a choice behind a full session. The stored value reaches the
 * client through `GET /api/auth/me` and is cached in `localStorage`, which is what the next
 * boot applies before first paint.
 */
let ctx: AuthTestContext;

afterEach(async () => {
  if (ctx) await ctx.cleanup();
});

describe('the locale guess in bootstrap.js', () => {
  it('comes from Accept-Language, per request, and sets the direction before paint', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: 'x' });

    const persian = await ctx.app.inject({
      method: 'GET',
      url: '/x/bootstrap.js',
      headers: { 'accept-language': 'fa-IR,fa;q=0.9,en;q=0.8' },
    });
    expect(persian.body).toContain('window.__LOCALE__ = "fa"');
    // The direction is set by this script and not by React, which is what makes "no
    // left-to-right flash on a Persian page" structural rather than a race.
    expect(persian.body).toContain("document.documentElement.dir = window.__LOCALE__ === 'fa'");

    const english = await ctx.app.inject({
      method: 'GET',
      url: '/x/bootstrap.js',
      headers: { 'accept-language': 'en-GB,en;q=0.9' },
    });
    expect(english.body).toContain('window.__LOCALE__ = "en"');

    // Per request, so it cannot be cached — which is why the route is `no-store` anyway.
    expect(persian.headers['cache-control']).toBe('no-store');
  });

  it('is a guess and not a lookup: no session, no database read', async () => {
    // The route is unauthenticated, and `routes/api.ts` keeps database reads off
    // unauthenticated routes on purpose. A stored preference must not be readable by anyone
    // who merely knows the base path, and the header is the only input here.
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: 'x' });
    const account = await enrollAccount(ctx);

    const stored = await ctx.inject({
      method: 'PATCH',
      url: ctx.url('/api/settings/locale'),
      cookies: { [SESSION_COOKIE]: account.cookie },
      payload: { locale: 'fa' },
    });
    expect(stored.statusCode, stored.body).toBe(200);

    // The stored choice is `fa`, and an anonymous request with an English header still gets
    // English: the script does not know about the row.
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: '/x/bootstrap.js',
      headers: { 'accept-language': 'en' },
    });
    expect(anonymous.body).toContain('window.__LOCALE__ = "en"');
  });
});

describe('PATCH /api/settings/locale', () => {
  it('stores the choice and returns it, for a full session', async () => {
    ctx = await createAuthTestServer();
    const account = await enrollAccount(ctx);

    const res = await ctx.inject({
      method: 'PATCH',
      url: ctx.url('/api/settings/locale'),
      cookies: { [SESSION_COOKIE]: account.cookie },
      payload: { locale: 'fa' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json() as LocaleResponse).toEqual({ locale: 'fa' });

    const me = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/auth/me'),
      cookies: { [SESSION_COOKIE]: account.cookie },
    });
    expect((me.json() as MeResponse).locale).toBe('fa');
  });

  it('reports null until a choice has been made, because null is not English', async () => {
    // The distinction the column exists for: *never chosen* leaves the `Accept-Language` guess
    // in force, while *chose English* overrides a Persian browser. Collapsing them would mean a
    // Persian operator's first visit could never be Persian.
    ctx = await createAuthTestServer();
    const account = await enrollAccount(ctx);

    const me = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/auth/me'),
      cookies: { [SESSION_COOKIE]: account.cookie },
    });
    expect((me.json() as MeResponse).locale).toBeNull();
    expect(
      (getDb().prepare('SELECT locale FROM users WHERE id = 1').get() as { locale: unknown })
        .locale,
    ).toBeNull();
  });

  it('refuses a locale the panel has no dictionary for', async () => {
    ctx = await createAuthTestServer();
    const account = await enrollAccount(ctx);

    for (const locale of ['de', '', 'FA', 'en-GB', null, 42]) {
      const res = await ctx.inject({
        method: 'PATCH',
        url: ctx.url('/api/settings/locale'),
        cookies: { [SESSION_COOKIE]: account.cookie },
        payload: { locale },
      });
      expect(res.statusCode, JSON.stringify(locale)).toBe(400);
      // The generic reason phrase, as everywhere: zod's own message names the field and its
      // constraint, which is a free hint about what the server expects.
      expect(res.json()).toMatchObject({ error: 'Bad Request' });
    }
  });

  it('is not writable by a pre session, so the login screen switches language client-side', async () => {
    // A `pre` session has passed one factor. It may reach the second-factor endpoints and
    // nothing else — and a write to the `users` row is emphatically something else. The
    // language toggle before sign-in therefore stores its choice in `localStorage`, where
    // `bootstrap.js` reads it on the next load.
    ctx = await createAuthTestServer();
    await enrollAccount(ctx);

    const login = await postLogin(ctx);
    const pre = ctx.cookieFrom(login)!;

    const res = await ctx.inject({
      method: 'PATCH',
      url: ctx.url('/api/settings/locale'),
      cookies: { [SESSION_COOKIE]: pre },
      payload: { locale: 'fa' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('needs the CSRF header like every other mutation', async () => {
    // `ctx.inject` adds the pair; a bare `app.inject` does not, which is what makes this a
    // statement about the route rather than about the helper.
    ctx = await createAuthTestServer();
    const account = await enrollAccount(ctx);

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: ctx.url('/api/settings/locale'),
      cookies: { [SESSION_COOKIE]: account.cookie },
      payload: { locale: 'fa' },
    });
    expect(res.statusCode).toBe(403);
  });
});
