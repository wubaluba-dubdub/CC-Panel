import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { InjectOptions, Response as InjectResponse } from 'light-my-request';
import { COOKIE_BASE_NAMES, SECURE_PREFIX } from '../../src/server/plugins/cookies.js';
import { CSRF_HEADER, csrfTokenFor } from '../../src/server/services/csrf.service.js';
import { hashToken } from '../../src/server/services/session.service.js';
import { TOTP_PERIOD_SECONDS } from '../../src/server/services/totp.service.js';
import { createAuthTestServer, totpCodeAt, type AuthTestContext } from '../helpers/auth-harness.js';

/**
 * M1.6 part 3.1 — the panel behind Railway's edge, with Railway's actual headers.
 *
 * The `Origin`/`Host` validation from M1.5 is the one control in this panel whose
 * correctness depends on what a proxy we do not control puts in the headers, which
 * makes it the thing most likely to break on a first deployment and the thing least
 * likely to be caught by any test written against a direct connection. So the header
 * set below is replayed verbatim, including the two headers that exist only at
 * Railway (`X-Railway-Edge`, `X-Railway-Request-Id`) — not because the panel reads
 * them, but because a test that quietly dropped the unfamiliar ones would not be
 * replaying the request.
 *
 * The verified fact this leans on is that **the edge overwrites a client-supplied
 * `X-Forwarded-Host` with the real public domain**: sending
 * `x-forwarded-host: example.com` from curl arrives at the app as the Railway domain.
 * So in production there is a single value, written by the immediate hop, which is
 * exactly what the rightmost-hop rule expects. The appended shape
 * (`evil.example, <real>`) is tested anyway, because "the edge overwrites it" is a
 * property of someone else's software and the panel should not be relying on it.
 *
 * Both `PANEL_TRUST_PROXY` settings are driven, and the second block is where the
 * runbook recommendation comes from.
 */

const RAILWAY_DOMAIN = 'cc-panel-production.up.railway.app';
const RAILWAY_ORIGIN = `https://${RAILWAY_DOMAIN}`;
const CLIENT_IP = '203.0.113.7';

/** The session cookie's name under an https public origin. */
const SESSION_COOKIE = `${SECURE_PREFIX}${COOKIE_BASE_NAMES.session}`;
const CSRF_COOKIE = `${SECURE_PREFIX}${COOKIE_BASE_NAMES.csrf}`;

type Headers = Record<string, string>;

/**
 * A request as it arrives at the app from Railway's edge.
 *
 * Verbatim from the observed set, in the same order, plus `Origin` — which the list
 * does not mention because it is the browser's, not the edge's, and it is the one this
 * check is actually about on a mutating request.
 */
function edgeHeaders(over: Headers = {}): Headers {
  return {
    host: RAILWAY_DOMAIN,
    'x-forwarded-for': CLIENT_IP,
    'x-forwarded-host': RAILWAY_DOMAIN,
    'x-forwarded-proto': 'https',
    'x-real-ip': CLIENT_IP,
    'x-railway-edge': 'railway/us-west2',
    'x-railway-request-id': 'Ncq0Qb1XQ0-VGCu6RmVX8w',
    'x-request-start': String(Date.now()),
    origin: RAILWAY_ORIGIN,
    ...over,
  };
}

async function prodServer(trustProxy: boolean): Promise<AuthTestContext> {
  return createAuthTestServer({
    NODE_ENV: 'production',
    PANEL_PUBLIC_URL: RAILWAY_ORIGIN,
    PANEL_TRUST_PROXY: trustProxy,
  });
}

/** `app.inject`, with the CSRF pair filled in when a session cookie is supplied. */
function inject(ctx: AuthTestContext, opts: InjectOptions & { cookie?: string }): Promise<InjectResponse> {
  const { cookie, ...rest } = opts;
  if (cookie === undefined) return ctx.app.inject(rest);

  const session = ctx.app.auth.sessions.resolve(cookie);
  if (session === null) throw new Error('the supplied cookie does not resolve to a session');
  const csrf = csrfTokenFor(session.id, hashToken(cookie));

  return ctx.app.inject({
    ...rest,
    cookies: { [SESSION_COOKIE]: cookie, [CSRF_COOKIE]: csrf },
    headers: { ...((rest.headers as Headers | undefined) ?? {}), [CSRF_HEADER]: csrf },
  });
}

function sessionCookieFrom(res: InjectResponse): string {
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (cookie === undefined || cookie.value === '') {
    throw new Error(`no ${SESSION_COOKIE} in the response: ${res.statusCode} ${res.body}`);
  }
  return cookie.value;
}

/** The password step, presented as the edge would present it. */
function login(ctx: AuthTestContext, headers: Headers = edgeHeaders()): Promise<InjectResponse> {
  return ctx.app.inject({
    method: 'POST',
    url: ctx.url('/api/auth/login'),
    headers,
    payload: { username: 'admin', password: 'correct-horse-battery-staple' },
  });
}

describe('with PANEL_TRUST_PROXY on — the deployed configuration', () => {
  let ctx: AuthTestContext | null = null;

  afterEach(async () => {
    if (ctx !== null) await ctx.cleanup();
    ctx = null;
  });

  it('accepts a mutating request carrying the exact header set', async () => {
    ctx = await prodServer(true);
    const res = await login(ctx);
    expect(res.statusCode).toBe(200);
    // And the cookie it set is the production one, which is the other half of what
    // PANEL_PUBLIC_URL decides.
    expect(sessionCookieFrom(res)).not.toBe('');
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.secure).toBe(true);
  });

  it('accepts a client-supplied X-Forwarded-Host in front of the real one', async () => {
    ctx = await prodServer(true);
    // The shape the edge is documented not to produce — it overwrites rather than
    // appends. Asserted because the rightmost-hop rule is what makes the panel correct
    // regardless of which of the two the edge does.
    const res = await login(
      ctx,
      edgeHeaders({ 'x-forwarded-host': `evil.example, ${RAILWAY_DOMAIN}` }),
    );
    expect(res.statusCode).toBe(200);
  });

  it('rejects the same pair with the attacker on the right', async () => {
    ctx = await prodServer(true);
    // Which is what proves the previous case was the rule and not an accident: the
    // rightmost value is the only one honoured, in both directions.
    const res = await login(
      ctx,
      edgeHeaders({ 'x-forwarded-host': `${RAILWAY_DOMAIN}, evil.example` }),
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden', code: 'forbidden' });
  });

  it('honours the forwarded host over a poisoned Host header', async () => {
    ctx = await prodServer(true);
    // This is what trusting the proxy *means*, spelled out: the immediate hop's value
    // wins, so a `Host` the edge did not write is irrelevant. Correct here because the
    // edge overwrites the forwarded header, and load-bearing on the reasoning that it
    // is the only value not attacker-supplied.
    const res = await login(ctx, edgeHeaders({ host: 'evil.example' }));
    expect(res.statusCode).toBe(200);
  });

  it('rejects a forwarded plaintext hop, because the TLS terminator was bypassed', async () => {
    ctx = await prodServer(true);
    const res = await login(ctx, edgeHeaders({ 'x-forwarded-proto': 'http' }));
    expect(res.statusCode).toBe(403);
    // The verdict is logged, never sent.
    expect(res.body).not.toContain('scheme_downgrade');
  });

  it('rejects a foreign Origin even with every Railway header intact', async () => {
    ctx = await prodServer(true);
    const res = await login(ctx, edgeHeaders({ origin: 'https://evil.example' }));
    expect(res.statusCode).toBe(403);
  });

  it('carries a full session, a CSRF pair and the edge headers through a mutating route', async () => {
    // The end-to-end version: everything the perimeter does, at once, on the request
    // shape a real browser behind the real edge would send.
    ctx = await prodServer(true);

    const pre = sessionCookieFrom(await login(ctx));
    const enroll = await inject(ctx, {
      method: 'POST',
      url: ctx.url('/api/auth/totp/enroll'),
      headers: edgeHeaders(),
      cookie: pre,
    });
    expect(enroll.statusCode).toBe(200);
    const { secret } = enroll.json() as { secret: string };

    const verified = await inject(ctx, {
      method: 'POST',
      url: ctx.url('/api/auth/totp/enroll/verify'),
      headers: edgeHeaders(),
      cookie: pre,
      payload: { code: totpCodeAt(secret, ctx.clock.now()) },
    });
    expect(verified.statusCode).toBe(200);
    const full = sessionCookieFrom(verified);

    const mutating = await inject(ctx, {
      method: 'POST',
      url: ctx.url('/api/sessions/revoke-others'),
      headers: edgeHeaders(),
      cookie: full,
    });
    expect(mutating.statusCode).toBe(200);
    expect(mutating.json()).toEqual({ revoked: 0 });

    // A second, complete login through the edge, for the same reason the container
    // smoke test does one: enrolment and login are different paths.
    ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
    const again = sessionCookieFrom(await login(ctx));
    const second = await inject(ctx, {
      method: 'POST',
      url: ctx.url('/api/auth/login/totp'),
      headers: edgeHeaders(),
      cookie: again,
      payload: { code: totpCodeAt(secret, ctx.clock.now()) },
    });
    expect(second.statusCode).toBe(200);
  });

  it('records the forwarded client address as display-only metadata', async () => {
    // `X-Forwarded-For` is honoured by Fastify's `trustProxy` and reaches the session
    // row and the audit row. Nothing decides from it — that is the M1.4 rule, enforced
    // statically by `no-ip-decisions.test.ts` — but it is why the operator can
    // recognise their own session in the list.
    ctx = await prodServer(true);
    const pre = sessionCookieFrom(await login(ctx));
    const me = await ctx.app.inject({
      method: 'GET',
      url: ctx.url('/api/auth/me'),
      headers: edgeHeaders(),
      cookies: { [SESSION_COOKIE]: pre },
    });
    expect(me.statusCode).toBe(200);
    expect(JSON.stringify(me.json())).toContain(CLIENT_IP);
  });
});

describe('with PANEL_TRUST_PROXY off — and what that silently costs', () => {
  let ctx: AuthTestContext | null = null;

  afterEach(async () => {
    if (ctx !== null) await ctx.cleanup();
    ctx = null;
  });

  it('still accepts the real header set, because the edge also sets Host correctly', async () => {
    // So the naive test — "does it work?" — passes either way, which is precisely why
    // the setting needs a recommendation with a reason attached rather than a shrug.
    ctx = await prodServer(false);
    const res = await login(ctx);
    expect(res.statusCode).toBe(200);
  });

  it('ignores X-Forwarded-Host entirely, in both directions', async () => {
    ctx = await prodServer(false);

    // A poisoned forwarded header is inert...
    const poisoned = await login(ctx, edgeHeaders({ 'x-forwarded-host': 'evil.example' }));
    expect(poisoned.statusCode).toBe(200);

    // ...and so is a correct one, so a `Host` the edge did not rewrite is fatal. This
    // is the case that breaks if anything ever sits in front of Railway.
    const hostOnly = await login(ctx, edgeHeaders({ host: 'evil.example' }));
    expect(hostOnly.statusCode).toBe(403);
  });

  it('LOSES the scheme-downgrade check, which is the reason to leave it on', async () => {
    // The finding. With the proxy untrusted, `X-Forwarded-Proto` is not read at all, so
    // a request that arrived over plaintext — the TLS terminator bypassed, the panel
    // reachable directly on its container port — is indistinguishable from one that did
    // not. Under `PANEL_TRUST_PROXY=true` the same request is a `scheme_downgrade` 403.
    ctx = await prodServer(false);
    const res = await login(ctx, edgeHeaders({ 'x-forwarded-proto': 'http' }));
    expect(res.statusCode).toBe(200);
  });

  it('is the setting the runbook must not recommend, for three reasons at once', async () => {
    ctx = await prodServer(false);

    // 1. No scheme-downgrade detection (above).
    // 2. The client address collapses to the container network's own address, so the
    //    session list and every audit row show the proxy instead of the client. It
    //    decides nothing — but it is the only thing that lets the operator tell their
    //    own session from someone else's.
    const pre = sessionCookieFrom(await login(ctx));
    const me = await ctx.app.inject({
      method: 'GET',
      url: ctx.url('/api/auth/me'),
      headers: edgeHeaders(),
      cookies: { [SESSION_COOKIE]: pre },
    });
    expect(JSON.stringify(me.json())).not.toContain(CLIENT_IP);

    // 3. And the reason it is safe to leave on: the rightmost-hop rule means the only
    //    value honoured is the one the immediate hop wrote, and Railway's edge
    //    overwrites what the client sent. Asserted in the block above.
  });
});

/**
 * M1.6 part 3.3 — `PANEL_PUBLIC_URL` is resolved in exactly one place.
 *
 * It is load-bearing in three at once: the cookie **name** prefix, the `Secure`
 * attribute, and `Origin`/`Host` validation. A second reader would be a second opinion
 * about what this panel's own origin is, and the failure mode of a disagreement is the
 * worst one available — a login that appears to work and then does not, because the
 * browser silently dropped a cookie whose name it would not accept over the scheme it
 * saw.
 *
 * Enforced the same way the client-IP and cookie rules are: a scan, so the property is
 * a test rather than a convention.
 */
describe('the public origin has one resolver', () => {
  const SERVER_ROOT = join(import.meta.dirname, '..', '..', 'src', 'server');

  /**
   * Three files may name the variables, and each for a different reason.
   *
   * - `utils/public-origin.ts` **resolves** them. This is the decision.
   * - `env.ts` **parses** them into the typed `Env`. It validates presence, not meaning.
   * - `cli/preflight.ts` **reports** them, and decides nothing: it prints whether each is
   *   set and then hands the same `Env` to the same resolver, so that what it says is
   *   what boot would do rather than a second opinion about it.
   *
   * Anything else in the offender list is the finding, not the exemption.
   */
  const ORIGIN_READERS = new Set(['utils/public-origin.ts', 'env.ts', 'cli/preflight.ts']);

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (entry.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('reads the variables in one module and derives the origin in one function', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SERVER_ROOT)) {
      const rel = relative(SERVER_ROOT, file).split('\\').join('/');
      if (ORIGIN_READERS.has(rel)) continue;

      const lines = readFileSync(file, 'utf-8').split('\n');
      for (const [index, line] of lines.entries()) {
        // Prose about the policy is the point of the policy; only code counts.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (/\b(PANEL_PUBLIC_URL|RAILWAY_PUBLIC_DOMAIN)\b/.test(code)) {
          offenders.push(`${rel}:${index + 1} ${code.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('calls resolvePublicOrigin from boot and from the preflight report, and nowhere else', () => {
    const callers: string[] = [];
    for (const file of sourceFiles(SERVER_ROOT)) {
      const rel = relative(SERVER_ROOT, file).split('\\').join('/');
      if (rel === 'utils/public-origin.ts') continue;
      const text = readFileSync(file, 'utf-8');
      for (const line of text.split('\n')) {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (/resolvePublicOrigin\s*\(/.test(code)) callers.push(rel);
      }
    }
    // Exactly two, and it matters which: `app.ts` resolves it once at boot and hands the
    // result to everything downstream, and `cli/preflight.ts` calls the *same* resolver so
    // that the check it prints is the decision boot would make rather than a re-derivation
    // of it. A third caller would be a place that could disagree.
    expect([...new Set(callers)].sort()).toEqual(['app.ts', 'cli/preflight.ts']);
    expect(callers.filter((c) => c === 'app.ts')).toHaveLength(1);
  });

  it('states the resolved origin and the cookie profile it selected, at boot', () => {
    // The line an operator reads when a login "works" and then 401s. Asserted on the
    // source rather than by booting `index.ts`, which would need a real listen.
    const index = readFileSync(join(SERVER_ROOT, 'index.ts'), 'utf-8');
    expect(index).toContain('panel configuration resolved');
    for (const field of [
      'publicOrigin',
      'originSource',
      'cookieProfile',
      'sessionCookie',
      'listenHost',
      'trustProxy',
    ]) {
      expect(index, field).toContain(field);
    }
    // And it must not carry the one thing that *is* secret.
    expect(index).not.toMatch(/basePath\s*:/);
  });
});
