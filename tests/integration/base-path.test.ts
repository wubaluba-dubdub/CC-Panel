import { describe, it, expect, afterEach } from 'vitest';
import { createTestServer, type TestContext } from '../helpers/test-server.js';
import {
  renderBootstrapScript,
  renderPlaceholderHtml,
} from '../../src/server/plugins/base-path.js';

describe('M1.2 — Base path routing and bootstrap', () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  describe('Routing', () => {
    it('mounts app routes under the secret base path only', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'secret-xyz' });

      for (const url of ['/', '/login', '/bootstrap.js']) {
        const res = await ctx.app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(404);
      }

      const inside = await ctx.app.inject({ method: 'GET', url: '/secret-xyz/' });
      expect(inside.statusCode).toBe(200);
      expect(inside.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(inside.body).toContain('Panel shell — Phase 2');
    });

    it('serves the placeholder with and without the trailing slash', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'testpath' });

      const withSlash = await ctx.app.inject({ method: 'GET', url: '/testpath/' });
      const withoutSlash = await ctx.app.inject({ method: 'GET', url: '/testpath' });

      expect(withSlash.statusCode).toBe(200);
      expect(withoutSlash.statusCode).toBe(200);
      expect(withoutSlash.body).toBe(withSlash.body);
    });

    it('GET /healthz returns exactly {"ok":true} outside the prefix', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'secret' });

      const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });
  });

  describe('F1 — bootstrap script instead of an inline script', () => {
    it('serves window.__BASE__ from a same-origin file', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'testpath' });

      const res = await ctx.app.inject({ method: 'GET', url: '/testpath/bootstrap.js' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/javascript; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toBe('window.__BASE__ = "/testpath";\n');
    });

    it('references the bootstrap script with a src attribute and no inline script', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'testpath' });

      const res = await ctx.app.inject({ method: 'GET', url: '/testpath/' });

      expect(res.body).toContain('<!DOCTYPE html>');
      expect(res.body).toContain('<script src="/testpath/bootstrap.js"></script>');

      // The CSP is script-src 'self' with no unsafe-inline, so an inline
      // assignment would be blocked by the browser and window.__BASE__ would be
      // undefined. Nothing may reintroduce one.
      expect(res.body).not.toContain('window.__BASE__');
      const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i;
      expect(res.body).not.toMatch(inlineScript);
    });

    it('escapes the base path so an operator-supplied value cannot break out', async () => {
      // Exercised against the renderers directly rather than over inject():
      // PANEL_BASE_PATH is operator-supplied and unvalidated, but a quote in it
      // is not round-trippable through inject()'s URL parsing, so the routing
      // layer is the wrong place to assert escaping.
      expect(renderPlaceholderHtml('a"b')).toContain(
        '<script src="/a&quot;b/bootstrap.js"></script>',
      );
      expect(renderPlaceholderHtml("a'b<c&d")).toContain(
        '<script src="/a&#39;b&lt;c&amp;d/bootstrap.js"></script>',
      );
      expect(renderBootstrapScript('a"b')).toBe('window.__BASE__ = "/a\\"b";\n');
      expect(renderBootstrapScript('a\\b')).toBe('window.__BASE__ = "/a\\\\b";\n');
    });

    it('places the bootstrap script before anything else executable', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'testpath' });

      const res = await ctx.app.inject({ method: 'GET', url: '/testpath/' });
      const scripts = [...res.body.matchAll(/<script\b[^>]*>/gi)];

      expect(scripts).toHaveLength(1);
      expect(scripts[0]![0]).toBe('<script src="/testpath/bootstrap.js">');
      // Blocking, not deferred: the Phase 2 bundle will be a module and modules
      // are always deferred, so a plain classic script here is guaranteed to run
      // first.
      expect(scripts[0]![0]).not.toMatch(/\b(defer|async|type=)/);
    });
  });

  describe('F7 — constant-time base path gate', () => {
    it('returns a byte-identical 404 for every path outside the prefix', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'correct-base-path' });

      const paths = [
        '/',
        '/login',
        '/api/health',
        '/random-xyz-123',
        '/admin',
        '/wp-login.php',
        '/__panel_not_found',
        // Near misses of increasing accuracy: none of these may look different
        // from a random path, or the prefix can be walked one character at a time.
        '/c',
        '/co',
        '/correct-base-pat',
        '/correct-base-pathX',
        '/correct-base-path-extra',
        '/Correct-Base-Path',
        // Empty first segment.
        '//correct-base-path/',
      ];

      const responses = await Promise.all(
        paths.map((url) => ctx.app.inject({ method: 'GET', url })),
      );

      responses.forEach((res, i) => {
        expect(res.statusCode, paths[i]).toBe(404);
        expect(res.body, paths[i]).toBe('{"error":"Not Found"}');
      });

      expect(new Set(responses.map((r) => r.body)).size).toBe(1);
      expect(new Set(responses.map((r) => r.headers['content-type'])).size).toBe(1);
    });

    it('rejects a percent-encoded spelling of the base path', async () => {
      // 0x78 is 'x'. The comparison is on the raw segment on purpose: decoding
      // first is what opens the door to prefix-confusion bypasses.
      ctx = await createTestServer({ PANEL_BASE_PATH: 'xyz' });

      const res = await ctx.app.inject({ method: 'GET', url: '/%78yz/' });
      expect(res.statusCode).toBe(404);
    });

    it('gates the base path on the query-stripped pathname', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'xyz' });

      const ok = await ctx.app.inject({ method: 'GET', url: '/xyz/?a=b' });
      expect(ok.statusCode).toBe(200);

      const notOk = await ctx.app.inject({ method: 'GET', url: '/nope?a=/xyz/' });
      expect(notOk.statusCode).toBe(404);
    });
  });

  describe('Base path secrecy', () => {
    it('never echoes the base path in a 404, a 500, or /healthz', async () => {
      const secret = 'secret-base-123';
      ctx = await createTestServer(
        { PANEL_BASE_PATH: secret },
        {
          beforeReady: (app) => {
            app.get(`/${secret}/__throw`, async () => {
              throw new Error('deliberate test failure');
            });
          },
        },
      );

      for (const url of ['/wrong-path', '/healthz', `/${secret}/__throw`]) {
        const res = await ctx.app.inject({ method: 'GET', url });
        expect(res.body, url).not.toContain(secret);
      }
    });

    it('does not hint that a prefix exists', async () => {
      ctx = await createTestServer();

      const res = await ctx.app.inject({ method: 'GET', url: '/some-random-path' });
      expect(res.body).not.toContain('base');
      expect(res.body).not.toContain('prefix');
      expect(res.body).not.toContain('panel');
    });
  });
});
