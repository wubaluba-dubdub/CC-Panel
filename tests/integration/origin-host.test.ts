import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/server/env.js';
import {
  createOriginPolicy,
  splitAuthority,
  validateRequestOrigin,
  type OriginCheckInput,
  type OriginPolicy,
  type OriginVerdict,
} from '../../src/server/plugins/origin-check.js';
import { resolvePublicOrigin } from '../../src/server/utils/public-origin.js';
import { curl, listenLoopback } from '../helpers/curl.js';
import { createTestServer, type TestContext } from '../helpers/test-server.js';

/**
 * `Origin` and `Host` validation — M1.5.
 *
 * The control this file exists to pin is a *negative* one: the expected origin is
 * **never derived from the request**. The implementation this replaced compared
 * `Origin` against `` `${req.protocol}://${req.host}` ``, which is circular — an
 * attacker who can make a browser send `Host: evil.example` and
 * `Origin: https://evil.example` satisfies it, and both headers are theirs to
 * choose. Every case below therefore fixes the expectation in *configuration*
 * (`PANEL_PUBLIC_URL` → `RAILWAY_PUBLIC_DOMAIN` → the development fallback) and
 * then varies the request.
 *
 * Two layers, deliberately:
 *
 * - the exported `validateRequestOrigin` as a pure function, in the raw
 *   `{ method, headers, url }` shape the **Phase 3 WebSocket upgrade handler** will
 *   hand it. That handler never becomes a Fastify request, so a test that only went
 *   through `inject` would leave the shape it depends on unexercised.
 * - the wired Fastify hook, over the wire with curl, because `Host` is the one
 *   header `app.inject()` synthesises for itself. `inject` will send whatever
 *   `Host` you ask it to, but a test that never used a real client would not notice
 *   if the hook read `req.host` (Fastify's parsed, proxy-aware value) instead of
 *   the raw header it is supposed to read.
 */

/** A complete `Env`, so `resolvePublicOrigin` sees exactly what boot would see. */
const BASE_ENV: Env = {
  PANEL_MASTER_KEY: Buffer.from('a'.repeat(32)).toString('base64'),
  PANEL_TRUST_PROXY: true,
  PANEL_DATA_DIR: '/tmp/panel-origin-test-unused',
  PORT: 3000,
  PANEL_NOTIFY_INCLUDE_LINKS: false,
  PANEL_NOTIFY_LOCALE: 'en',
  PANEL_WATCHDOG_ENABLED: true,
  PANEL_WATCHDOG_MEMORY_PERCENT: 85,
  PANEL_WATCHDOG_DISK_PERCENT: 80,
  NODE_ENV: 'development',
};

function policyFor(over: Partial<Env> = {}): OriginPolicy {
  const env: Env = { ...BASE_ENV, ...over };
  return createOriginPolicy(env, resolvePublicOrigin(env));
}

type Headers = Record<string, string | string[] | undefined>;

/** The raw request shape, with the defaults an `http.IncomingMessage` would have. */
function request(over: { method?: string; headers?: Headers; url?: string } = {}): OriginCheckInput {
  return {
    method: over.method ?? 'GET',
    headers: over.headers ?? {},
    url: over.url ?? '/basepath/api/anything',
  };
}

/** Development: no `PANEL_PUBLIC_URL`, so `http://localhost:3000`. */
const dev = policyFor();
/** Production behind Railway's TLS terminator. */
const prod = policyFor({
  NODE_ENV: 'production',
  PANEL_PUBLIC_URL: 'https://panel.example.com',
});
/** Production with `PANEL_TRUST_PROXY=false`: forwarded headers are inert. */
const prodDirect = policyFor({
  NODE_ENV: 'production',
  PANEL_PUBLIC_URL: 'https://panel.example.com',
  PANEL_TRUST_PROXY: false,
});

const OK: OriginVerdict = { ok: true };
const HOST_MISSING: OriginVerdict = { ok: false, reason: 'host_missing' };
const HOST_MISMATCH: OriginVerdict = { ok: false, reason: 'host_mismatch' };
const ORIGIN_MISMATCH: OriginVerdict = { ok: false, reason: 'origin_mismatch' };
const DOWNGRADE: OriginVerdict = { ok: false, reason: 'scheme_downgrade' };

describe('the expected origin is resolved from configuration, in one place', () => {
  it('prefers PANEL_PUBLIC_URL over RAILWAY_PUBLIC_DOMAIN', () => {
    const p = policyFor({
      PANEL_PUBLIC_URL: 'https://panel.example.com',
      RAILWAY_PUBLIC_DOMAIN: 'cc-panel.up.railway.app',
    });
    expect(p.origin.source).toBe('PANEL_PUBLIC_URL');
    expect(p.origin.origin).toBe('https://panel.example.com');
  });

  it('falls back to RAILWAY_PUBLIC_DOMAIN, always as https', () => {
    const p = policyFor({ RAILWAY_PUBLIC_DOMAIN: 'cc-panel.up.railway.app' });
    expect(p.origin.source).toBe('RAILWAY_PUBLIC_DOMAIN');
    expect(p.origin.origin).toBe('https://cc-panel.up.railway.app');
    expect(p.origin.secure).toBe(true);
  });

  it('falls back to localhost:PORT in development, and only in development', () => {
    expect(dev.origin.source).toBe('development-fallback');
    expect(dev.origin.origin).toBe('http://localhost:3000');
    expect(dev.production).toBe(false);

    expect(() => policyFor({ NODE_ENV: 'production' })).toThrow(/PANEL_PUBLIC_URL is required/);
  });

  it('carries the trust-proxy and production flags so nothing re-reads process.env', () => {
    expect(prod.production).toBe(true);
    expect(prod.trustProxy).toBe(true);
    expect(prodDirect.trustProxy).toBe(false);
  });
});

describe('Host is validated on every method, not only on mutations', () => {
  it('accepts the configured authority, case-insensitively', () => {
    expect(validateRequestOrigin(dev, request({ headers: { host: 'localhost:3000' } }))).toEqual(OK);
    expect(validateRequestOrigin(dev, request({ headers: { host: 'LOCALHOST:3000' } }))).toEqual(OK);
    expect(validateRequestOrigin(prod, request({ headers: { host: 'panel.example.com' } }))).toEqual(OK);
    expect(validateRequestOrigin(prod, request({ headers: { host: 'PANEL.Example.COM' } }))).toEqual(OK);
  });

  it('rejects a poisoned Host on a GET, because Host poisoning is not a mutation-only problem', () => {
    // A `GET` that passes its Host through into an absolute URL — a password-reset
    // link, a redirect, a cache key — is the classic Host-poisoning shape, and it
    // never mutates anything.
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(
        validateRequestOrigin(prod, request({ method, headers: { host: 'evil.example' } })),
        method,
      ).toEqual(HOST_MISMATCH);
    }
  });

  it('rejects a request with no Host at all', () => {
    expect(validateRequestOrigin(prod, request())).toEqual(HOST_MISSING);
    expect(validateRequestOrigin(prod, request({ headers: { host: '   ' } }))).toEqual(HOST_MISSING);
  });

  it('refuses to guess when Host is duplicated', () => {
    // Two `Host` headers is a request-smuggling shape. Picking either one is a
    // decision about which proxy in the chain to believe, and there is no answer
    // that is right in general — so it is refused rather than resolved.
    expect(
      validateRequestOrigin(prod, request({ headers: { host: ['panel.example.com', 'evil.example'] } })),
    ).toEqual(HOST_MISSING);
    expect(
      validateRequestOrigin(prod, request({ headers: { host: ['panel.example.com'] } })),
    ).toEqual(HOST_MISSING);
  });

  it('accepts any loopback authority outside production', () => {
    // So `localhost:3000`, `127.0.0.1:3000` and `[::1]:3000` all work in
    // development without anybody configuring PANEL_PUBLIC_URL.
    for (const host of ['127.0.0.1:3000', '127.0.0.1', '[::1]:3000', '[::1]', 'app.localhost:5173']) {
      expect(validateRequestOrigin(dev, request({ headers: { host } })), host).toEqual(OK);
    }
    expect(validateRequestOrigin(dev, request({ headers: { host: 'evil.example' } }))).toEqual(
      HOST_MISMATCH,
    );
  });

  it('matches exactly in production — no loopback allowance, no default port', () => {
    for (const host of ['localhost:3000', '127.0.0.1', '[::1]', 'panel.example.com.evil.example']) {
      expect(validateRequestOrigin(prod, request({ headers: { host } })), host).toEqual(
        HOST_MISMATCH,
      );
    }
    // A browser never sends the default port, and `new URL()` never keeps it, so
    // the two agree by construction. Pinned because a hand-written comparison that
    // "helpfully" normalised ports would be a silent widening.
    expect(
      validateRequestOrigin(prod, request({ headers: { host: 'panel.example.com:443' } })),
    ).toEqual(HOST_MISMATCH);
  });

  it('exempts /healthz exactly, and nothing that merely looks like it', () => {
    // Docker's HEALTHCHECK reaches the container as `localhost:3000` while the
    // public host is something else entirely, and a health probe that 403s is a
    // container-kill primitive. The exemption is on the pathname, so a query string
    // does not defeat it and a near-miss path does not inherit it.
    expect(validateRequestOrigin(prod, request({ url: '/healthz' }))).toEqual(OK);
    expect(
      validateRequestOrigin(prod, request({ url: '/healthz?probe=1', headers: { host: 'evil.example' } })),
    ).toEqual(OK);
    expect(
      validateRequestOrigin(prod, request({ url: '/healthzz', headers: { host: 'evil.example' } })),
    ).toEqual(HOST_MISMATCH);
    expect(
      validateRequestOrigin(prod, request({ url: '/healthz/../api', headers: { host: 'evil.example' } })),
    ).toEqual(HOST_MISMATCH);
  });
});

describe('X-Forwarded-Host: honoured only under PANEL_TRUST_PROXY, and only the immediate hop', () => {
  it('lets a trusted proxy supply the public host the internal Host cannot carry', () => {
    // Railway's router forwards to the container as an internal address, so the
    // `Host` a trusted deployment sees is never the public one.
    expect(
      validateRequestOrigin(
        prod,
        request({ headers: { host: 'internal.railway.internal:8080', 'x-forwarded-host': 'panel.example.com' } }),
      ),
    ).toEqual(OK);
  });

  it('takes the rightmost value, in both spellings Node produces', () => {
    // `X-Forwarded-*` accumulates left to right, so the client's own value ends up
    // leftmost and the value written by the proxy we are actually talking to ends up
    // rightmost. Node exposes repeated headers as a comma-joined string for most
    // names and as an array for a few, so both are unpicked.
    const joined = 'evil.example, panel.example.com';
    const array = ['evil.example', 'panel.example.com'];
    expect(
      validateRequestOrigin(prod, request({ headers: { host: 'x', 'x-forwarded-host': joined } })),
    ).toEqual(OK);
    expect(
      validateRequestOrigin(prod, request({ headers: { host: 'x', 'x-forwarded-host': array } })),
    ).toEqual(OK);
  });

  it('does not scan the list for a value that happens to match', () => {
    // The real host appearing *anywhere* in the chain is not evidence: only the
    // rightmost element was written by the hop we trust. A validator that searched
    // the list would accept any request whose client prepended the right string.
    expect(
      validateRequestOrigin(
        prod,
        request({ headers: { host: 'x', 'x-forwarded-host': 'panel.example.com, evil.example' } }),
      ),
    ).toEqual(HOST_MISMATCH);
  });

  it('skips empty elements, and an empty header falls back to Host', () => {
    expect(
      validateRequestOrigin(
        prod,
        request({ headers: { host: 'x', 'x-forwarded-host': 'panel.example.com,  ' } }),
      ),
    ).toEqual(OK);
    // An all-empty header must not blank the check out: it falls through to `Host`,
    // which is then checked as usual.
    expect(
      validateRequestOrigin(
        prod,
        request({ headers: { host: 'panel.example.com', 'x-forwarded-host': '' } }),
      ),
    ).toEqual(OK);
    expect(
      validateRequestOrigin(prod, request({ headers: { host: 'evil.example', 'x-forwarded-host': '' } })),
    ).toEqual(HOST_MISMATCH);
  });

  it('ignores the header entirely when PANEL_TRUST_PROXY is off', () => {
    // Untrusted deployment: the header is attacker-supplied, so it must not be able
    // to satisfy the check…
    expect(
      validateRequestOrigin(
        prodDirect,
        request({ headers: { host: 'internal:8080', 'x-forwarded-host': 'panel.example.com' } }),
      ),
    ).toEqual(HOST_MISMATCH);
    // …nor to break one that would otherwise pass.
    expect(
      validateRequestOrigin(
        prodDirect,
        request({ headers: { host: 'panel.example.com', 'x-forwarded-host': 'evil.example' } }),
      ),
    ).toEqual(OK);
  });
});

describe('X-Forwarded-Proto: a plaintext hop under an https origin means TLS was bypassed', () => {
  const forwarded = (proto: string | string[]): OriginCheckInput =>
    request({ headers: { host: 'panel.example.com', 'x-forwarded-proto': proto } });

  it('rejects a forwarded http hop, case-insensitively', () => {
    expect(validateRequestOrigin(prod, forwarded('http'))).toEqual(DOWNGRADE);
    expect(validateRequestOrigin(prod, forwarded('HTTP'))).toEqual(DOWNGRADE);
  });

  it('accepts https, and uses the immediate hop for this too', () => {
    expect(validateRequestOrigin(prod, forwarded('https'))).toEqual(OK);
    expect(validateRequestOrigin(prod, forwarded('http,https'))).toEqual(OK);
    expect(validateRequestOrigin(prod, forwarded('https,http'))).toEqual(DOWNGRADE);
    expect(validateRequestOrigin(prod, forwarded(['https', 'http']))).toEqual(DOWNGRADE);
  });

  it('is inert when the header is absent, untrusted, or the origin is not https', () => {
    expect(validateRequestOrigin(prod, request({ headers: { host: 'panel.example.com' } }))).toEqual(OK);
    expect(
      validateRequestOrigin(
        prodDirect,
        request({ headers: { host: 'panel.example.com', 'x-forwarded-proto': 'http' } }),
      ),
    ).toEqual(OK);
    // Development is served over http on purpose; there is nothing to downgrade.
    expect(
      validateRequestOrigin(dev, request({ headers: { host: 'localhost:3000', 'x-forwarded-proto': 'http' } })),
    ).toEqual(OK);
  });

  it('reports the Host problem first, so the reason is deterministic', () => {
    expect(
      validateRequestOrigin(
        prod,
        request({ headers: { host: 'evil.example', 'x-forwarded-proto': 'http' } }),
      ),
    ).toEqual(HOST_MISMATCH);
  });
});

describe('Origin is checked on state-changing requests', () => {
  const devHost = { host: 'localhost:3000' };
  const prodHost = { host: 'panel.example.com' };

  it('is not checked on safe methods', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(
        validateRequestOrigin(
          prod,
          request({ method, headers: { ...prodHost, origin: 'https://evil.example' } }),
        ),
        method,
      ).toEqual(OK);
    }
  });

  it('is checked on every mutating method, whatever the case of the verb', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete']) {
      expect(
        validateRequestOrigin(
          prod,
          request({ method, headers: { ...prodHost, origin: 'https://evil.example' } }),
        ),
        method,
      ).toEqual(ORIGIN_MISMATCH);
    }
  });

  it('allows an absent Origin', () => {
    // Browsers attach `Origin` to every mutating request, so absent means a
    // non-browser client — curl, a script, the panel's own tests — which has no
    // ambient credentials to be tricked into spending. `SameSite=Strict` is the
    // control that stops the browser case; this header is the belt.
    expect(validateRequestOrigin(prod, request({ method: 'POST', headers: prodHost }))).toEqual(OK);
  });

  it('rejects the literal "null" an opaque origin sends', () => {
    // A sandboxed iframe or a `data:` document serialises its origin as `null`.
    // That is a *present* header and it is not ours, so it is a rejection — and it
    // must not fall into the development loopback allowance, since `new URL('null')`
    // does not parse and `'null'` is not a loopback anything.
    expect(
      validateRequestOrigin(dev, request({ method: 'POST', headers: { ...devHost, origin: 'null' } })),
    ).toEqual(ORIGIN_MISMATCH);
    expect(
      validateRequestOrigin(prod, request({ method: 'POST', headers: { ...prodHost, origin: 'null' } })),
    ).toEqual(ORIGIN_MISMATCH);
  });

  it('rejects an unparseable Origin instead of tolerating it', () => {
    expect(
      validateRequestOrigin(dev, request({ method: 'POST', headers: { ...devHost, origin: 'not a url' } })),
    ).toEqual(ORIGIN_MISMATCH);
    // A duplicated Origin arrives comma-joined, which parses as nothing.
    expect(
      validateRequestOrigin(
        dev,
        request({ method: 'POST', headers: { ...devHost, origin: 'http://localhost:3000, https://evil.example' } }),
      ),
    ).toEqual(ORIGIN_MISMATCH);
  });

  it('accepts a loopback Origin outside production, so the Vite dev server can reach the API', () => {
    // M2 serves the client from `:5173` while the API listens on `:3000`. In
    // production the match is exact and this allowance is gone.
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:5173', 'http://localhost:5173', 'http://[::1]:5173']) {
      expect(
        validateRequestOrigin(dev, request({ method: 'POST', headers: { ...devHost, origin } })),
        origin,
      ).toEqual(OK);
    }
  });

  it('requires the exact configured origin in production, scheme included', () => {
    expect(
      validateRequestOrigin(
        prod,
        request({ method: 'POST', headers: { ...prodHost, origin: 'https://panel.example.com' } }),
      ),
    ).toEqual(OK);
    for (const origin of [
      'http://panel.example.com',
      'https://panel.example.com:443',
      'https://panel.example.com.evil.example',
      'http://127.0.0.1:5173',
    ]) {
      expect(
        validateRequestOrigin(prod, request({ method: 'POST', headers: { ...prodHost, origin } })),
        origin,
      ).toEqual(ORIGIN_MISMATCH);
    }
  });
});

describe('the WebSocket handshake — Phase 3', () => {
  const wsUrl = '/basepath/api/terminal';
  const devHost = { host: 'localhost:3000' };

  /**
   * A handshake is a `GET`, so the mutating-method test alone would wave it through
   * with its `Origin` unexamined — and attaching a terminal to a socket is the most
   * state-changing thing this panel will ever do. `SameSite` does protect the
   * cookie on a cross-site handshake, but the whole point of this check is to be the
   * layer that does not depend on the browser getting that right.
   */
  it('is Origin-checked because of the Upgrade header, not the method', () => {
    expect(
      validateRequestOrigin(
        dev,
        request({ url: wsUrl, headers: { ...devHost, upgrade: 'websocket', origin: 'https://evil.example' } }),
      ),
    ).toEqual(ORIGIN_MISMATCH);
    // Without the header the same request is an ordinary GET and is not checked —
    // which is exactly the gap the header test closes.
    expect(
      validateRequestOrigin(
        dev,
        request({ url: wsUrl, headers: { ...devHost, origin: 'https://evil.example' } }),
      ),
    ).toEqual(OK);
  });

  it('matches the token case-insensitively and in both header spellings', () => {
    const evil = { ...devHost, origin: 'https://evil.example' };
    for (const upgrade of ['websocket', 'WebSocket', 'WEBSOCKET', ' websocket ', ['websocket'], 'websocket, foo']) {
      expect(
        validateRequestOrigin(dev, request({ url: wsUrl, headers: { ...evil, upgrade } })),
        JSON.stringify(upgrade),
      ).toEqual(ORIGIN_MISMATCH);
    }
  });

  it('leaves other upgrade protocols alone', () => {
    // `h2c` is not this panel's business and has no ambient-credential problem to
    // solve; naming `websocket` explicitly keeps the check narrow.
    expect(
      validateRequestOrigin(
        dev,
        request({ url: wsUrl, headers: { ...devHost, upgrade: 'h2c', origin: 'https://evil.example' } }),
      ),
    ).toEqual(OK);
  });

  it('accepts the configured origin and an absent one', () => {
    expect(
      validateRequestOrigin(
        dev,
        request({ url: wsUrl, headers: { ...devHost, upgrade: 'websocket', origin: 'http://localhost:3000' } }),
      ),
    ).toEqual(OK);
    expect(
      validateRequestOrigin(dev, request({ url: wsUrl, headers: { ...devHost, upgrade: 'websocket' } })),
    ).toEqual(OK);
  });

  it('still validates Host on the handshake', () => {
    expect(
      validateRequestOrigin(
        prod,
        request({ url: wsUrl, headers: { host: 'evil.example', upgrade: 'websocket' } }),
      ),
    ).toEqual(HOST_MISMATCH);
  });

  it('is callable in the raw IncomingMessage shape, with no method or url at all', () => {
    // This is the contract the Phase 3 `server.on('upgrade')` handler depends on: it
    // has an `http.IncomingMessage`, never a `FastifyRequest`, and no Fastify hook
    // will ever run for it. See CLAUDE.md.
    const raw: OriginCheckInput = {
      method: undefined,
      headers: { host: 'panel.example.com', upgrade: 'websocket', origin: 'https://panel.example.com' },
      url: undefined,
    };
    expect(validateRequestOrigin(prod, raw)).toEqual(OK);
    expect(
      validateRequestOrigin(prod, { ...raw, headers: { ...raw.headers, origin: 'https://evil.example' } }),
    ).toEqual(ORIGIN_MISMATCH);
    expect(
      validateRequestOrigin(prod, { ...raw, headers: { ...raw.headers, host: 'evil.example' } }),
    ).toEqual(HOST_MISMATCH);
  });
});

describe('splitAuthority', () => {
  it('splits a plain authority', () => {
    expect(splitAuthority('panel.example.com')).toEqual({ hostname: 'panel.example.com', port: null });
    expect(splitAuthority('panel.example.com:3000')).toEqual({ hostname: 'panel.example.com', port: '3000' });
    expect(splitAuthority('  panel.example.com:3000  ')).toEqual({ hostname: 'panel.example.com', port: '3000' });
  });

  it('does not mistake an IPv6 literal colon for a port separator', () => {
    expect(splitAuthority('[::1]')).toEqual({ hostname: '::1', port: null });
    expect(splitAuthority('[::1]:3000')).toEqual({ hostname: '::1', port: '3000' });
    expect(splitAuthority('[2001:db8::1]:8443')).toEqual({ hostname: '2001:db8::1', port: '8443' });
    // Unterminated bracket: hand the whole thing back rather than invent a hostname.
    expect(splitAuthority('[::1')).toEqual({ hostname: '[::1', port: null });
  });
});

/**
 * The wired hook, over a real socket.
 *
 * One server at a time: `initDb` is a module singleton, so two live servers would
 * share one database. Each block boots its own, binds loopback, and cleans up.
 */
describe('the wired hook — development, over the wire with curl', () => {
  let ctx: TestContext;
  let root = '';
  let api = '';

  beforeAll(async () => {
    ctx = await createTestServer({ PANEL_BASE_PATH: 'origintest' });
    root = await listenLoopback(ctx.app);
    api = `${root}/origintest/api/auth/me`;
  });

  afterAll(async () => {
    if (ctx !== undefined) await ctx.cleanup();
  });

  it('accepts the loopback Host curl actually sends', async () => {
    // The configured origin here is the development fallback, `http://localhost`,
    // and curl sends `Host: 127.0.0.1:<port>`. Different authority, both loopback,
    // accepted outside production — which is what makes `curl 127.0.0.1` work
    // without configuration. 401 because there is no session, not 403.
    const res = await curl([api]);
    expect(res.status).toBe(401);
  });

  it('rejects a poisoned Host with a bare reason phrase and nothing else', async () => {
    const res = await curl(['-H', 'Host: evil.example', api]);
    expect(res.status).toBe(403);
    // Two regressions in one assertion. The body is the status's reason phrase, so
    // the hook's internal reason (`host_mismatch`) never reaches a client. And it is
    // a clean 403 rather than a 500: the origin hook runs *after* the cookie plugin,
    // because a request rejected before cookie parsing reached the API's `onSend`
    // hook with `req.cookies` still null and turned this into an error page. See the
    // hook-ordering comment in `src/server/app.ts`.
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden', code: 'forbidden' });
    expect(res.body).not.toContain('host_mismatch');
    expect(res.body).not.toContain('evil.example');
  });

  it('rejects a mutating request with a foreign Origin before the handler sees it', async () => {
    const login = `${root}/origintest/api/auth/login`;
    const body = JSON.stringify({ username: 'admin', password: 'correct-horse-battery-staple' });
    const args = ['-X', 'POST', '-H', 'content-type: application/json', '--data-binary', body];

    const rejected = await curl([...args, '-H', 'Origin: https://evil.example', login]);
    expect(rejected.status).toBe(403);
    expect(JSON.parse(rejected.body)).toEqual({ error: 'Forbidden', code: 'forbidden' });

    // The same credentials with no Origin, and with the real one, are accepted — so
    // the 403 above is the header and not the payload.
    const absent = await curl([...args, login]);
    expect(absent.status).toBe(200);
    const present = await curl([...args, '-H', `Origin: ${root}`, login]);
    expect(present.status).toBe(200);
  });

  it('exempts /healthz from the Host check even when the Host is absurd', async () => {
    const res = await curl(['-H', 'Host: evil.example', `${root}/healthz`]);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});

describe('the wired hook — production, over the wire with curl', () => {
  let ctx: TestContext;
  let root = '';
  let api = '';

  beforeAll(async () => {
    // A production origin the test can never actually be reached at, which is the
    // point: every request below arrives on loopback and has to satisfy a check that
    // knows nothing about how it arrived.
    ctx = await createTestServer({
      PANEL_BASE_PATH: 'origintest',
      NODE_ENV: 'production',
      PANEL_PUBLIC_URL: 'https://panel.example.com',
    });
    root = await listenLoopback(ctx.app);
    api = `${root}/origintest/api/auth/me`;
  });

  afterAll(async () => {
    if (ctx !== undefined) await ctx.cleanup();
  });

  it('drops the loopback allowance in production', async () => {
    // The very request the development server accepted above.
    const res = await curl([api]);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden', code: 'forbidden' });
  });

  it('accepts the configured Host', async () => {
    const res = await curl(['-H', 'Host: panel.example.com', api]);
    expect(res.status).toBe(401);
  });

  it('accepts a trusted proxy X-Forwarded-Host, and only its rightmost value', async () => {
    const ok = await curl(['-H', 'X-Forwarded-Host: panel.example.com', api]);
    expect(ok.status).toBe(401);

    const chained = await curl(['-H', 'X-Forwarded-Host: evil.example, panel.example.com', api]);
    expect(chained.status).toBe(401);

    const spoofed = await curl(['-H', 'X-Forwarded-Host: panel.example.com, evil.example', api]);
    expect(spoofed.status).toBe(403);
  });

  it('rejects a forwarded plaintext hop under an https origin', async () => {
    const res = await curl([
      '-H',
      'Host: panel.example.com',
      '-H',
      'X-Forwarded-Proto: http',
      api,
    ]);
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('scheme_downgrade');
  });

  it('still exempts /healthz, because a 403 there is a container-kill primitive', async () => {
    const res = await curl([`${root}/healthz`]);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('never reaches the hook at all when Host is absent', async () => {
    // `-H 'Host:'` removes curl's generated header. Node's HTTP parser requires
    // `Host` on HTTP/1.1 and answers 400 itself, so the `host_missing` verdict is
    // unreachable over TCP — it is covered by the unit cases above, and this is the
    // layer in front of it.
    const res = await curl(['-H', 'Host:', api]);
    expect(res.status).toBe(400);
  });
});
