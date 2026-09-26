import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILD_IDENTITY } from '../../src/server/utils/build-info.js';
import { renderBootstrapScript } from '../../src/server/plugins/base-path.js';
import {
  createAuthTestServer,
  enrollAccount,
  loginFully,
  postLogin,
  SESSION_COOKIE,
  type AuthTestContext,
} from '../helpers/auth-harness.js';

/**
 * The build id on the wire, for a session that has not finished signing in.
 *
 * ── Why this is a separate file, and why the hoisted line is load-bearing ────
 *
 * `src/server/utils/build-info.ts` resolves `BUILD_IDENTITY` **once, at import time**, and the
 * route reads that constant. A test run has no Railway variables, so the constant is `null`
 * there — which makes every "the id is absent" assertion pass for the wrong reason: `null` is
 * absent from a body that never mentions it either way. `vi.hoisted` runs before this file's
 * imports are evaluated, so the resolver sees a documented SHA and the route has a **measured**
 * value to leak. The first test below asserts exactly that, and the file stops being a test of
 * nothing at that point.
 *
 * What these tests see: bytes on the response, for a real `pre` session and a real `full`
 * session against the same account, plus the two public surfaces. What they do not see: the
 * rendered footer, which is `tests/integration/build.test.ts`'s business because it needs the
 * client actually built, and `docs/SECURITY.md` §*Manual browser checks* item 46 after that.
 */

/** A documented SHA, so every absence assertion below has something to look for. */
const SHA = 'feedfacecafe1234';
const BUILD_ID = SHA.slice(0, 7);

vi.hoisted(() => {
  process.env.RAILWAY_GIT_COMMIT_SHA = 'feedfacecafe1234';
});

afterAll(() => {
  // Back out, so a file that runs later in the same worker resolves the id it would have had.
  delete process.env.RAILWAY_GIT_COMMIT_SHA;
});

describe('M2.2 — buildId is absent until both factors are satisfied', () => {
  let ctx: AuthTestContext | undefined;

  afterEach(async () => {
    if (ctx !== undefined) await ctx.cleanup();
    ctx = undefined;
  });

  it('resolves a measured id here, so none of the absences below is vacuous', () => {
    expect(BUILD_IDENTITY.source).toBe('env');
    expect(BUILD_IDENTITY.buildId).toBe(BUILD_ID);
    expect(BUILD_ID).toHaveLength(7);
  });

  it('omits the key entirely from a pre session and carries it on a full one', async () => {
    ctx = await createAuthTestServer();
    const { secret } = await enrollAccount(ctx);

    // Password step only: a five-minute `pre` session, exactly what a stolen password buys.
    const login = await postLogin(ctx);
    expect(login.statusCode).toBe(200);
    const preCookie = ctx.cookieFrom(login);
    expect(preCookie).not.toBeNull();

    const pre = await ctx.app.inject({
      method: 'GET',
      url: ctx.url('/api/auth/me'),
      cookies: { [SESSION_COOKIE]: preCookie! },
    });
    expect(pre.statusCode).toBe(200);
    // Bytes, not a parsed object: `key in body` and `body.key === undefined` are the same
    // answer for an omitted field, and the difference between `{}` and `{"buildId":null}`
    // is exactly what a `hasOwnProperty` check cannot see from the other side.
    expect(pre.payload).not.toContain('buildId');
    expect(pre.payload).not.toContain(BUILD_ID);
    const preStage = (JSON.parse(pre.payload) as { stage: string }).stage;
    expect(preStage, 'the session under test was not a pre one').not.toBe('authenticated');

    const { cookie } = await loginFully(ctx, secret);
    const full = await ctx.app.inject({
      method: 'GET',
      url: ctx.url('/api/auth/me'),
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(full.statusCode).toBe(200);
    expect(full.payload).toContain(`"buildId":"${BUILD_ID}"`);
    expect((JSON.parse(full.payload) as { stage: string }).stage).toBe('authenticated');

    // The two bodies of the same account differ by the key and by nothing else that matters:
    // the gate is the whole change, not a side effect of a different response shape.
    expect(pre.payload).toContain('"stage":"totp"');
  });

  it('keeps it out of the unauthenticated, error and public surfaces', async () => {
    ctx = await createAuthTestServer();

    const anonymous = await ctx.app.inject({ method: 'GET', url: ctx.url('/api/auth/me') });
    expect(anonymous.statusCode).not.toBe(200);
    expect(anonymous.payload).not.toContain('buildId');
    expect(anonymous.payload).not.toContain(BUILD_ID);

    const health = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.payload).not.toContain('buildId');
    expect(health.payload).not.toContain(BUILD_ID);

    // The bootstrap script is served before login to anyone who can reach the prefix, and it is
    // the only dynamic asset the shell asks for.
    const bootstrap = renderBootstrapScript({
      basePath: 'example-base',
      locale: 'en',
      csrfCookieName: 'panel_csrf',
    });
    expect(bootstrap).not.toContain('buildId');
    expect(bootstrap).not.toContain(BUILD_ID);

    // And an authorization failure on a full-session route: an error body is still a body.
    const { secret } = await enrollAccount(ctx);
    const login = await postLogin(ctx);
    const denied = await ctx.app.inject({
      method: 'GET',
      url: ctx.url('/api/audit'),
      cookies: { [SESSION_COOKIE]: ctx.cookieFrom(login)! },
    });
    expect(denied.statusCode).toBeGreaterThanOrEqual(400);
    expect(denied.payload).not.toContain('buildId');
    expect(denied.payload).not.toContain(BUILD_ID);
    // Not vacuous: the same server does answer a full session with it.
    const { cookie } = await loginFully(ctx, secret);
    const allowed = await ctx.app.inject({
      method: 'GET',
      url: ctx.url('/api/audit'),
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.payload).not.toContain(BUILD_ID);
  });

  it('types the client so a pre result cannot be read as if it had one', () => {
    // The byte-level rule, restated as a compile-time one. `npm run typecheck` is the
    // assertion; this pins the three declarations it depends on so a refactor cannot quietly
    // widen `MeResponse` back to a single interface with an optional field.
    const read = (file: string): string => readFileSync(join(import.meta.dirname, '..', '..', file), 'utf-8');

    const types = read('src/shared/types.ts');
    expect(types).toContain('export type MeResponse = AuthenticatedMe | PendingMe;');
    const pending = /export interface PendingMe extends MeBase \{[\s\S]*?\n\}/.exec(types)?.[0];
    expect(pending, 'PendingMe was not found where it was').toBeDefined();
    expect(pending).not.toContain('buildId');
    const authenticated = /export interface AuthenticatedMe extends MeBase \{[\s\S]*?\n\}/.exec(
      types,
    )?.[0];
    expect(authenticated).toContain('buildId: string | null');
    expect(authenticated).toContain("stage: 'authenticated'");

    // `Shell` is the only component that reads it, and its parameter type is the authenticated
    // shape — so the narrow in `App.tsx` is not decoration, it is what makes the call compile.
    const shell = read('src/client/Shell.tsx');
    expect(shell).toContain('me: AuthenticatedMe;');
    expect(shell).not.toMatch(/me:\s*MeResponse/);
    const app = read('src/client/App.tsx');
    expect(app).toContain("me !== null && me.stage === 'authenticated'");
  });

  it('builds the two branches from one response, and only the full one has the field', () => {
    // The route itself, so the byte-level result above is pinned to the code that produced it
    // rather than to whatever a future refactor happens to emit.
    const route = readFileSync(
      join(import.meta.dirname, '..', '..', 'src/server/routes/auth.ts'),
      'utf-8',
    );
    expect(route.match(/buildId:/g)).toHaveLength(1);
    expect(route).toContain("session.authLevel === 'full'");
    expect(route).toContain("? { ...common, stage: 'authenticated', buildId: BUILD_IDENTITY.buildId }");
    expect(route).toContain(": { ...common, stage: runtime.totp.isEnabled() ? 'totp' : 'setup' }");
    // And no second place that could reintroduce it on the other branch.
    expect(route.match(/BUILD_IDENTITY/g), 'import plus one use').toHaveLength(2);
  });
});
