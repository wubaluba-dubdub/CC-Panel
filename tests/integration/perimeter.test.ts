import { describe, it, expect, afterEach } from 'vitest';
import {
  createTestServer,
  FIXTURE_ASSET_CSS,
  FIXTURE_ASSET_JS,
  type TestContext,
} from '../helpers/test-server.js';

/**
 * Headers whose value legitimately varies per response. They are asserted
 * individually below; everything else must match the expected map exactly.
 */
const VOLATILE_HEADERS = ['date', 'content-length', 'connection'] as const;

function stableHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...headers };
  for (const name of VOLATILE_HEADERS) delete copy[name];
  return copy;
}

/**
 * The expected header map, written out as literals on purpose.
 *
 * These are deliberately NOT imported from src/server/plugins/security-headers.ts.
 * The previous version of this suite asserted only that headers were *present*,
 * which is how twenty-five tests stayed green while four header values were wrong
 * or missing. Importing the constants would reintroduce the same blind spot from
 * the other direction: the test would agree with whatever the plugin says.
 */
const PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), ' +
  'microphone=(), midi=(), payment=(), usb=()';

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; " +
  "form-action 'self'";

const HSTS = 'max-age=63072000; includeSubDomains; preload';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': PERMISSIONS_POLICY,
  'content-security-policy': CSP,
} as const;

/**
 * A production boot needs a configured https public origin or it refuses to start —
 * `resolvePublicOrigin` treats the alternative as a fatal misconfiguration rather
 * than shipping a session cookie the browser would drop. Supplied here so these
 * two cases exercise the production *headers*, which is what they are about;
 * `tests/integration/cookies.test.ts` is where the guard itself is tested.
 */
const PROD_URL = 'https://panel.example';

/**
 * A production server answers as its configured public origin and nothing else, so
 * an injected request has to say so. `light-my-request` defaults to
 * `Host: localhost:80`, which M1.5's Host check correctly rejects with a 403 — and
 * a 403 carries the security headers too, so the assertions below would have gone
 * on passing while measuring the wrong response.
 */
const PROD_HOST = { host: 'panel.example' };

describe('M1.2 — Perimeter', () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  describe('Complete header map (byte-for-byte)', () => {
    it('sends exactly the expected headers on the shell page', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });

      const res = await ctx.app.inject({ method: 'GET', url: '/x/' });

      expect(res.statusCode).toBe(200);
      expect(stableHeaders(res.headers)).toEqual({
        'content-type': 'text/html; charset=utf-8',
        // **Changed in M2.1.** The document now carries the base path in three attributes
        // and the content-hashed names of the assets it needs, so a cached copy after a
        // regenerated prefix or a redeploy asks for URLs that no longer exist — a blank
        // page with 404s in the network panel and nothing in the console. It is ~2 KB and
        // uncacheable; the assets it names are cached for a year, which is where the win is.
        'cache-control': 'no-store',
        ...SECURITY_HEADERS,
      });

      // The excluded headers are still checked, just not for an exact value.
      expect(res.headers['date']).toMatch(/GMT$/);
      expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.body));
    });

    it('sends exactly the expected headers on a deep link, which is the same document', async () => {
      // The sixth shape, new in M2.1: a client route that no server route matches, answered
      // with the shell so that a hard refresh of `/<base>/security` works. Identical to the
      // shell above, which is the point — if these two ever diverge, one of them is being
      // served by something other than the fallback.
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/x/security/sessions',
        headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      });

      expect(res.statusCode).toBe(200);
      expect(stableHeaders(res.headers)).toEqual({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        ...SECURITY_HEADERS,
      });
    });

    it('sends exactly the expected headers on a hashed asset', async () => {
      // The seventh shape, new in M2.1, and the only response in the panel with a *positive*
      // caching directive. `etag`, `last-modified` and `accept-ranges` are switched off in
      // `plugins/base-path.ts`: a content-hashed immutable file needs no validator, and
      // their absence is what makes this map assertable byte-for-byte rather than
      // approximately.
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });

      const js = await ctx.app.inject({ method: 'GET', url: `/x/assets/${FIXTURE_ASSET_JS}` });
      expect(js.statusCode).toBe(200);
      expect(stableHeaders(js.headers)).toEqual({
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
        ...SECURITY_HEADERS,
      });

      // The stylesheet takes the same path, and `style-src 'self'` is what makes serving it
      // as a file rather than injecting it the only option.
      const css = await ctx.app.inject({ method: 'GET', url: `/x/assets/${FIXTURE_ASSET_CSS}` });
      expect(css.statusCode).toBe(200);
      expect(stableHeaders(css.headers)).toEqual({
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
        ...SECURITY_HEADERS,
      });
    });

    it('sends exactly the expected headers on the bootstrap script', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });

      const res = await ctx.app.inject({ method: 'GET', url: '/x/bootstrap.js' });

      expect(res.statusCode).toBe(200);
      expect(stableHeaders(res.headers)).toEqual({
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
        ...SECURITY_HEADERS,
      });
    });

    it('sends exactly the expected headers on the generic 404', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });

      const res = await ctx.app.inject({ method: 'GET', url: '/definitely-not-the-base-path' });

      expect(res.statusCode).toBe(404);
      expect(stableHeaders(res.headers)).toEqual({
        'content-type': 'application/json; charset=utf-8',
        ...SECURITY_HEADERS,
      });
    });

    it('sends exactly the expected headers on /healthz', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });

      const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });

      expect(res.statusCode).toBe(200);
      expect(stableHeaders(res.headers)).toEqual({
        'content-type': 'application/json; charset=utf-8',
        // M1.6 added this one header, and only here. A response with no
        // `Cache-Control`, no `ETag` and no `Last-Modified` is heuristically cacheable,
        // and "the health endpoint said fine" is the last answer that should come out
        // of a cache. Nothing else in the panel gained a caching directive — see
        // `routes/healthz.ts`.
        'cache-control': 'no-store',
        ...SECURITY_HEADERS,
      });
    });

    it('sends exactly the expected headers on a 500', async () => {
      ctx = await createTestServer(
        { PANEL_BASE_PATH: 'x' },
        {
          beforeReady: (app) => {
            app.get('/x/__throw', async () => {
              throw new Error('deliberate test failure');
            });
          },
        },
      );

      const res = await ctx.app.inject({ method: 'GET', url: '/x/__throw' });

      expect(res.statusCode).toBe(500);
      expect(stableHeaders(res.headers)).toEqual({
        'content-type': 'application/json; charset=utf-8',
        ...SECURITY_HEADERS,
      });

      // Generic body: Fastify's default handler would echo the thrown message.
      expect(res.body).toBe('{"error":"Internal Server Error"}');
      expect(res.body).not.toContain('deliberate test failure');
    });

    it('adds Strict-Transport-Security in production and nothing else', async () => {
      const prod = await createTestServer({ PANEL_BASE_PATH: 'x', NODE_ENV: 'production', PANEL_PUBLIC_URL: PROD_URL });

      const res = await prod.app.inject({ method: 'GET', url: '/x/', headers: PROD_HOST });

      expect(res.statusCode).toBe(200);
      expect(stableHeaders(res.headers)).toEqual({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        ...SECURITY_HEADERS,
        'strict-transport-security': HSTS,
      });

      await prod.cleanup();
    });

    it('CSP is byte-identical in dev and production', async () => {
      const dev = await createTestServer({ PANEL_BASE_PATH: 'x', NODE_ENV: 'test' });
      const prod = await createTestServer({ PANEL_BASE_PATH: 'x', NODE_ENV: 'production', PANEL_PUBLIC_URL: PROD_URL });

      const resDev = await dev.app.inject({ method: 'GET', url: '/x/' });
      const resProd = await prod.app.inject({ method: 'GET', url: '/x/', headers: PROD_HOST });
      expect(resProd.statusCode).toBe(200);

      expect(resDev.headers['content-security-policy']).toBe(CSP);
      expect(resProd.headers['content-security-policy']).toBe(CSP);
      expect(CSP).not.toContain('unsafe-inline');
      expect(CSP).not.toContain('unsafe-eval');

      await dev.cleanup();
      await prod.cleanup();
    });
  });

  describe('F2 — X-XSS-Protection is gone', () => {
    it('never sends X-XSS-Protection', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });

      for (const url of [
        '/x/',
        '/x/bootstrap.js',
        `/x/assets/${FIXTURE_ASSET_JS}`,
        '/healthz',
        '/nope',
      ]) {
        const res = await ctx.app.inject({ method: 'GET', url });
        expect(res.headers['x-xss-protection']).toBeUndefined();
      }
    });
  });

  describe('F6 — Server and X-Powered-By stay absent', () => {
    it('omits both on a normal response, an error response, and the generic 404', async () => {
      ctx = await createTestServer(
        { PANEL_BASE_PATH: 'x' },
        {
          beforeReady: (app) => {
            app.get('/x/__throw', async () => {
              throw new Error('deliberate test failure');
            });
          },
        },
      );

      const normal = await ctx.app.inject({ method: 'GET', url: '/x/' });
      const error = await ctx.app.inject({ method: 'GET', url: '/x/__throw' });
      const notFound = await ctx.app.inject({ method: 'GET', url: '/nope' });

      expect(normal.statusCode).toBe(200);
      expect(error.statusCode).toBe(500);
      expect(notFound.statusCode).toBe(404);

      for (const res of [normal, error, notFound]) {
        expect(res.headers['server']).toBeUndefined();
        expect(res.headers['x-powered-by']).toBeUndefined();
      }
    });
  });
});
