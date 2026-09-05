import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  SESSION_COOKIE,
  createAuthTestServer,
  enrollAccount,
  postLogin,
  stepUp,
  type AuthTestContext,
} from '../helpers/auth-harness.js';
import { ERROR_CODES, isErrorCode, type ErrorResponse } from '../../src/shared/types.js';

/**
 * The error-code enum, which is the one thing M2.0 left open and the client cannot work
 * without.
 *
 * `app.setErrorHandler` sends only the status's standard reason phrase — deliberately, after
 * two credential leaks came out of error bodies — and R3 makes that phrase unusable for
 * display, because the interface is translated client-side and `"Forbidden"` can only ever be
 * English. So the body carries a code from a closed set, and this file asserts the two
 * properties that make the set safe:
 *
 *  1. **It is closed.** Nothing outside `ERROR_CODES` can reach a response body, including a
 *     `code` that a library put on its own error object.
 *  2. **It discloses nothing the status does not.** Every authentication rejection is
 *     `bad_credentials`: an unknown username, a wrong password, a wrong code, a *replayed*
 *     code and a spent recovery code are one answer, because the fixed dummy hash exists
 *     precisely so they are indistinguishable.
 */
let ctx: AuthTestContext;

afterEach(async () => {
  if (ctx) await ctx.cleanup();
});

const SERVER_ROOT = join(import.meta.dirname, '..', '..', 'src', 'server');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('the code set is closed', () => {
  it('never sends a code that is not in the enum', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: 'x' }, {
      beforeReady: (app) => {
        // Three shapes that are not `HttpError`: a bare throw, an error carrying a *string*
        // code of its own (which is what every Fastify internal error looks like), and one
        // carrying a plausible-looking code that is still not in the set.
        app.get('/x/__bare', async () => {
          throw new Error('deliberate');
        });
        app.get('/x/__fastify', async () => {
          const err = new Error('deliberate') as Error & { statusCode: number; code: string };
          err.statusCode = 400;
          err.code = 'FST_ERR_SOMETHING_INTERNAL';
          throw err;
        });
        app.get('/x/__plausible', async () => {
          const err = new Error('deliberate') as Error & { statusCode: number; code: string };
          err.statusCode = 403;
          err.code = 'insufficient_scope';
          throw err;
        });
      },
    });

    for (const path of ['/x/__bare', '/x/__fastify', '/x/__plausible']) {
      const res = await ctx.app.inject({ method: 'GET', url: path });
      const body = res.json() as ErrorResponse;
      expect(isErrorCode(body.code), `${path} sent ${String(body.code)}`).toBe(true);
      // And the library's own identifier is nowhere in the response.
      expect(res.body).not.toContain('FST_ERR');
      expect(res.body).not.toContain('insufficient_scope');
      expect(res.body).not.toContain('deliberate');
    }
  });

  it('answers a body over the limit with `too_large` rather than a library identifier', async () => {
    // The case that found this. `bodyLimit` rejections arrive at the handler carrying
    // `FST_ERR_CTP_BODY_TOO_LARGE`, and an error handler that forwarded `err.code` unchecked
    // would have put a library identifier into a response body — the same shape as the two
    // credential leaks that came out of error *messages*.
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: 'x' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: ctx.url('/api/auth/login'),
      payload: { username: 'a', password: 'p'.repeat(100 * 1024) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'Payload Too Large', code: 'too_large' });
  });

  it('carries a code on every error body the panel can produce, and nothing else', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: 'x' });
    const account = await enrollAccount(ctx);

    const probes: { label: string; run: () => Promise<{ statusCode: number; body: string }> }[] = [
      {
        label: 'no session',
        run: () => ctx.inject({ method: 'GET', url: ctx.url('/api/sessions') }),
      },
      {
        label: 'unknown path outside the prefix',
        run: () => ctx.app.inject({ method: 'GET', url: '/nope' }),
      },
      {
        label: 'unknown api path',
        run: () => ctx.app.inject({ method: 'GET', url: ctx.url('/api/nope') }),
      },
      {
        label: 'no step-up',
        run: () =>
          ctx.inject({
            method: 'POST',
            url: ctx.url('/api/secrets/reveal'),
            cookies: { [SESSION_COOKIE]: account.cookie },
            payload: { scope: 'global', name: 'nope' },
          }),
      },
      {
        label: 'bad body',
        run: () =>
          ctx.inject({
            method: 'PATCH',
            url: ctx.url('/api/settings/locale'),
            cookies: { [SESSION_COOKIE]: account.cookie },
            payload: { locale: 'de' },
          }),
      },
      {
        label: 'no csrf header',
        run: () =>
          ctx.app.inject({
            method: 'POST',
            url: ctx.url('/api/sessions/revoke-others'),
            cookies: { [SESSION_COOKIE]: account.cookie },
          }),
      },
    ];

    const seen = new Set<string>();
    for (const probe of probes) {
      const res = await probe.run();
      expect(res.statusCode, probe.label).toBeGreaterThanOrEqual(400);
      const body = JSON.parse(res.body) as ErrorResponse;
      // Exactly two keys. A third would be a place for prose to grow, and prose in a JSON body
      // is a string that can only ever be English.
      expect(Object.keys(body).sort(), probe.label).toEqual(['code', 'error']);
      expect(isErrorCode(body.code), `${probe.label}: ${String(body.code)}`).toBe(true);
      seen.add(body.code);
    }

    // The probes cover more than one code, so "they all pass" is not "they all say the same
    // thing".
    expect(seen.size).toBeGreaterThan(3);
    expect(seen).toContain('unauthenticated');
    expect(seen).toContain('step_up_required');
    expect(seen).toContain('csrf_invalid');
    expect(seen).toContain('bad_request');
    expect(seen).toContain('not_found');
  });

  it('carries no free text: every code is a bare lower-case identifier', () => {
    // A code is not a message. This is what stops the enum from becoming the place a
    // half-sentence ends up once somebody wants to say a bit more.
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[a-z][a-z_]{2,30}$/);
      expect(code).not.toContain(' ');
    }
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('is spelled in exactly one place, so the client cannot drift from it', () => {
    // A code literal outside the shared contract and the throw sites is a second enum. The scan
    // is over `src/server`, and the owners are the file that declares the set, the handler that
    // maps a status onto it, and the plugins that raise the four specific ones.
    const OWNERS = new Set([
      'app.ts',
      'plugins/auth.ts',
      'plugins/csrf.ts',
      'plugins/origin-check.ts',
      'plugins/rate-limit.ts',
      'routes/auth.ts',
      'routes/security.ts',
      'utils/single-flight.ts',
      // Two files whose own vocabularies happen to collide with a code, and neither is this
      // enum. `audit.service.ts` has `bad_credentials` as a failure **reason category** on an
      // audit row — the same words for the same idea in a log that is not a response body —
      // and `telegram.transport.ts` has `rate_limited` as a `TelegramRejection`, which is
      // Telegram rate-limiting *us*. Listed here with the reason rather than excluded by a
      // looser pattern, because a looser pattern would stop catching a real second spelling.
      'services/audit.service.ts',
      'services/telegram.transport.ts',
    ]);

    const offenders: string[] = [];
    for (const file of sourceFiles(SERVER_ROOT)) {
      const rel = relative(SERVER_ROOT, file).split('\\').join('/');
      if (OWNERS.has(rel)) continue;
      for (const [index, line] of readFileSync(file, 'utf-8').split('\n').entries()) {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        for (const value of ERROR_CODES) {
          if (new RegExp(`['"\`]${value}['"\`]`).test(code)) {
            offenders.push(`${rel}:${index + 1} ${value}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the codes disclose nothing the status does not', () => {
  it('answers every authentication rejection with the same code', async () => {
    ctx = await createAuthTestServer();
    const account = await enrollAccount(ctx);

    // A wrong password and an unknown username, which the fixed dummy hash makes
    // indistinguishable in timing — and which must stay indistinguishable in the body.
    const wrongPassword = await postLogin(ctx, { password: 'wrong-password-here' });
    const unknownUser = await postLogin(ctx, { username: 'nobody', password: 'wrong-password' });
    expect(wrongPassword.body).toBe(unknownUser.body);
    expect((wrongPassword.json() as ErrorResponse).code).toBe('bad_credentials');

    // A wrong second-factor code, and a *replayed* one — a code that really was valid. The
    // audit log distinguishes `bad_totp_code` from `replayed_totp_code`; the client does not,
    // because "that code was valid and already used" is a fact about the panel's state.
    const login = await postLogin(ctx);
    const pre = ctx.cookieFrom(login)!;
    const wrongCode = await ctx.inject({
      method: 'POST',
      url: ctx.url('/api/auth/login/totp'),
      cookies: { [SESSION_COOKIE]: pre },
      payload: { code: '000000' },
    });
    expect((wrongCode.json() as ErrorResponse).code).toBe('bad_credentials');

    // A recovery code that has already been spent.
    const spent = account.recoveryCodes[0]!;
    const second = await postLogin(ctx);
    const pre2 = ctx.cookieFrom(second)!;
    const first = await ctx.inject({
      method: 'POST',
      url: ctx.url('/api/auth/login/totp'),
      cookies: { [SESSION_COOKIE]: pre2 },
      payload: { code: spent },
    });
    expect(first.statusCode).toBe(200);

    const third = await postLogin(ctx);
    const pre3 = ctx.cookieFrom(third)!;
    const reused = await ctx.inject({
      method: 'POST',
      url: ctx.url('/api/auth/login/totp'),
      cookies: { [SESSION_COOKIE]: pre3 },
      payload: { code: spent },
    });
    expect(reused.statusCode).toBe(401);
    expect((reused.json() as ErrorResponse).code).toBe('bad_credentials');
  });

  it('says step_up_required only to a caller that already holds a full session', async () => {
    // Safe precisely because of that: the caller knows perfectly well whether it has stepped
    // up, so the code tells it nothing it could not determine. A caller with no session gets
    // `unauthenticated` and learns nothing about which routes are step-up gated.
    ctx = await createAuthTestServer();
    const account = await enrollAccount(ctx);

    const withSession = await ctx.inject({
      method: 'POST',
      url: ctx.url('/api/security/recovery-codes'),
      cookies: { [SESSION_COOKIE]: account.cookie },
    });
    expect(withSession.statusCode).toBe(403);
    expect((withSession.json() as ErrorResponse).code).toBe('step_up_required');

    const withoutSession = await ctx.inject({
      method: 'POST',
      url: ctx.url('/api/security/recovery-codes'),
    });
    expect(withoutSession.statusCode).toBe(401);
    expect((withoutSession.json() as ErrorResponse).code).toBe('unauthenticated');

    // And with a step-up it succeeds, so the 403 above was the gate and not the route.
    expect((await stepUp(ctx, account.cookie, account.secret)).statusCode).toBe(200);
    const granted = await ctx.inject({
      method: 'POST',
      url: ctx.url('/api/security/recovery-codes'),
      cookies: { [SESSION_COOKIE]: account.cookie },
    });
    expect(granted.statusCode).toBe(200);
  });
});
