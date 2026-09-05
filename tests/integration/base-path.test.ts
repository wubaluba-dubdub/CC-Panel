import { describe, it, expect, afterEach } from 'vitest';
import {
  createTestServer,
  FIXTURE_ASSET_CSS,
  FIXTURE_ASSET_JS,
  type TestContext,
} from '../helpers/test-server.js';
import {
  BASE_PATH_SENTINEL,
  loadShell,
  renderBootstrapScript,
  templateShell,
  wantsShell,
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
      expect(inside.body).toContain('<div id="root"></div>');
    });

    it('serves the shell with and without the trailing slash', async () => {
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
      // The first line, byte for byte. The rest of the script is asserted below; what
      // matters here is that the assignment is served as a file rather than inlined.
      expect(res.body.split('\n')[0]).toBe('window.__BASE__ = "/testpath";');
    });

    it('references the bootstrap script with a src attribute and no inline script', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'testpath' });

      const res = await ctx.app.inject({ method: 'GET', url: '/testpath/' });

      expect(res.body.toLowerCase()).toContain('<!doctype html>');
      expect(res.body).toContain('<script src="/testpath/bootstrap.js"></script>');

      // The CSP is script-src 'self' with no unsafe-inline, so an inline
      // assignment would be blocked by the browser and window.__BASE__ would be
      // undefined. Nothing may reintroduce one.
      expect(res.body).not.toContain('window.__BASE__');
      const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i;
      expect(res.body).not.toMatch(inlineScript);
    });

    it('escapes the base path so an operator-supplied value cannot break out', async () => {
      // Exercised against the renderer directly rather than over inject():
      // PANEL_BASE_PATH is operator-supplied and unvalidated, but a quote in it
      // is not round-trippable through inject()'s URL parsing, so the routing
      // layer is the wrong place to assert escaping.
      const script = renderBootstrapScript({
        basePath: 'a"b',
        locale: 'en',
        csrfCookieName: 'panel_csrf',
      });
      expect(script).toContain('window.__BASE__ = "/a\\"b";');
      expect(
        renderBootstrapScript({ basePath: 'a\\b', locale: 'en', csrfCookieName: 'panel_csrf' }),
      ).toContain('window.__BASE__ = "/a\\\\b";');
    });

    it('carries the CSRF cookie name, because the client must not guess it', async () => {
      // `__Secure-panel_csrf` over https and `panel_csrf` over loopback http, and
      // `plugins/cookies.ts` is the only file allowed to decide which. A hard-coded name in
      // the client is a 403 on every mutation, with a correct-looking cookie in the jar.
      ctx = await createTestServer({ PANEL_BASE_PATH: 'testpath' });

      const res = await ctx.app.inject({ method: 'GET', url: '/testpath/bootstrap.js' });
      expect(res.body).toContain(`window.__CSRF_COOKIE__ = "${ctx.app.auth.cookies.csrfName}"`);
      expect(res.body).toContain('window.__LOCALE__ = "en"');
      // And it sets the direction before first paint, which is the whole reason this file
      // is a blocking classic script in `<head>` rather than part of the module bundle.
      expect(res.body).toContain('document.documentElement.dir');
    });

    it('places the bootstrap script before the module bundle', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'testpath' });

      const res = await ctx.app.inject({ method: 'GET', url: '/testpath/' });
      const scripts = [...res.body.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);

      // Two: the classic bootstrap and the module bundle, in that order.
      expect(scripts).toHaveLength(2);
      expect(scripts[0]).toBe('<script src="/testpath/bootstrap.js">');
      // Blocking, not deferred: the bundle is a module and modules are always deferred, so
      // a plain classic script here is guaranteed to run first and `window.__BASE__` is on
      // the window before the app boots.
      expect(scripts[0]).not.toMatch(/\b(defer|async|type=)/);
      expect(scripts[1]).toContain('type="module"');

      // And still no inline script anywhere: `script-src 'self'` has no `unsafe-inline`.
      const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i;
      expect(res.body).not.toMatch(inlineScript);
    });
  });

  describe('M2.1 — the shell, the sentinel, and the SPA fallback', () => {
    it('substitutes the base path into every asset URL and leaves no sentinel', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'testpath' });

      const res = await ctx.app.inject({ method: 'GET', url: '/testpath/' });
      expect(res.statusCode).toBe(200);
      // A sentinel that reaches the browser is a page whose script tag 404s.
      expect(res.body).not.toContain(BASE_PATH_SENTINEL);
      expect(res.body).toContain(`/testpath/assets/${FIXTURE_ASSET_JS}`);
      expect(res.body).toContain(`/testpath/assets/${FIXTURE_ASSET_CSS}`);
      // Never cached: the document names the base path and the hashed assets, so a copy
      // that outlives either is a blank page with 404s and nothing in the console.
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('serves the shell for a deep link, so a hard refresh works', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'testpath' });

      const deep = await ctx.app.inject({
        method: 'GET',
        url: '/testpath/security/sessions',
        headers: { accept: 'text/html,application/xhtml+xml' },
      });
      expect(deep.statusCode).toBe(200);
      expect(deep.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(deep.body).toContain('<div id="root"></div>');
      // The absolute asset URL is why this works at any depth: `./assets/…` would resolve
      // to `/testpath/security/assets/…` here and 404.
      expect(deep.body).toContain(`/testpath/assets/${FIXTURE_ASSET_JS}`);
    });

    it('keeps the JSON 404 for an unknown API path, and for anything that did not ask for HTML', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'testpath' });

      const api = await ctx.app.inject({
        method: 'GET',
        url: '/testpath/api/does-not-exist',
        headers: { accept: 'text/html' },
      });
      expect(api.statusCode).toBe(404);
      expect(api.body).toBe('{"error":"Not Found"}');

      // A client that asked for JSON and got a page cannot report a useful error, and a
      // mistyped asset URL must be a 404 in the network panel rather than a page that
      // renders and then fails to parse as JavaScript.
      const asset = await ctx.app.inject({ method: 'GET', url: '/testpath/assets/nope.js' });
      expect(asset.statusCode).toBe(404);
      expect(asset.body).toBe('{"error":"Not Found"}');

      // And a mutation to an unknown path is not answered with a page either.
      const post = await ctx.app.inject({
        method: 'POST',
        url: '/testpath/anything',
        headers: { accept: 'text/html' },
      });
      expect(post.statusCode).toBe(404);
      expect(post.body).toBe('{"error":"Not Found"}');
    });

    it('leaves the out-of-prefix sink untouched, whatever it asks for', async () => {
      // The property the whole gate exists for. A browser navigation to a wrong prefix
      // must not be able to tell itself apart from a scanner's: both are the sink.
      ctx = await createTestServer({ PANEL_BASE_PATH: 'testpath' });

      for (const url of ['/', '/testpat', '/testpathX', '/__panel_not_found', '/anything']) {
        const res = await ctx.app.inject({
          method: 'GET',
          url,
          headers: { accept: 'text/html,application/xhtml+xml,*/*' },
        });
        expect(res.statusCode, url).toBe(404);
        expect(res.body, url).toBe('{"error":"Not Found"}');
      }
    });

    it('decides the fallback from the pathname, the method and Accept — and nothing else', async () => {
      // The pure function, driven directly, because the four conditions it satisfies at once
      // are the whole design and each one is a separate way to get this wrong.
      const base = 'p';
      const html = 'text/html,application/xhtml+xml';
      expect(wantsShell({ method: 'GET', url: '/p/security', accept: html, basePath: base })).toBe(
        true,
      );
      expect(wantsShell({ method: 'HEAD', url: '/p', accept: html, basePath: base })).toBe(true);
      // A query string is not part of the decision.
      expect(wantsShell({ method: 'GET', url: '/p/x?y=/p/api/', accept: html, basePath: base })).toBe(
        true,
      );
      expect(wantsShell({ method: 'POST', url: '/p/security', accept: html, basePath: base })).toBe(
        false,
      );
      expect(wantsShell({ method: 'GET', url: '/p/api/nope', accept: html, basePath: base })).toBe(
        false,
      );
      expect(wantsShell({ method: 'GET', url: '/p/api', accept: html, basePath: base })).toBe(false);
      expect(wantsShell({ method: 'GET', url: '/p/x', accept: 'application/json', basePath: base })).toBe(
        false,
      );
      expect(wantsShell({ method: 'GET', url: '/p/x', accept: undefined, basePath: base })).toBe(
        false,
      );
      // The sink, and a prefix that merely starts with the same characters.
      expect(
        wantsShell({ method: 'GET', url: '/__panel_not_found', accept: html, basePath: base }),
      ).toBe(false);
      expect(wantsShell({ method: 'GET', url: '/pretend/x', accept: html, basePath: base })).toBe(
        false,
      );
    });

    it('serves the hashed assets with a year of immutable caching', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'testpath' });

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/testpath/assets/${FIXTURE_ASSET_JS}`,
      });
      expect(res.statusCode).toBe(200);
      // Safe only because the filename contains a hash of the contents: a changed file is a
      // changed URL, so there is nothing for a stale cache to serve.
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.body).toContain('fixture');
    });

    it('never lets the static mount reach outside the assets directory', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'testpath' });

      for (const url of [
        '/testpath/assets/../index.html',
        '/testpath/assets/%2e%2e/index.html',
        '/testpath/assets/..%2findex.html',
      ]) {
        const res = await ctx.app.inject({ method: 'GET', url });
        expect(res.statusCode, url).not.toBe(200);
      }
    });

    it('says so in words when there is no client bundle, rather than serving a blank page', async () => {
      // The one failure this milestone can detect for itself. A blank page with a clean
      // console is the hardest thing here to diagnose, so the detectable case names the
      // command instead. `scripts/container-smoke.sh` fails on it, which is where a broken
      // image is supposed to be caught.
      ctx = await createTestServer({ PANEL_BASE_PATH: 'testpath' }, { clientDir: '' });

      const res = await ctx.app.inject({ method: 'GET', url: '/testpath/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('has not been built');
      expect(res.body).toContain('npm run build');
      // No inline script and no inline style, because the CSP applies to the diagnostic too.
      expect(res.body).not.toMatch(/<style|style="/i);
      expect(res.body).not.toMatch(/<script(?![^>]*\bsrc=)/i);

      // And a deep link is still a 404 rather than the diagnostic: turning every mistyped
      // URL into "the panel is not built" would bury the one page that says it.
      const deep = await ctx.app.inject({
        method: 'GET',
        url: '/testpath/security',
        headers: { accept: 'text/html' },
      });
      expect(deep.statusCode).toBe(404);
    });

    it('escapes the base path into the shell, because it lands in three attributes', async () => {
      // `PANEL_BASE_PATH` is operator-supplied and `env.ts` takes it as a bare string, so a
      // quote in it would terminate the attribute it is substituted into. The M1.2
      // placeholder escaped for exactly this reason and the rule survived the placeholder.
      expect(templateShell('<script src="/__PANEL_BASE__/x.js">', 'a"b')).toBe(
        '<script src="/a&quot;b/x.js">',
      );
      expect(templateShell('<link href="/__PANEL_BASE__/x.css">', "a'b<c&d")).toBe(
        '<link href="/a&#39;b&lt;c&amp;d/x.css">',
      );
      // And a generated prefix is untouched: 22 characters of base64url has nothing to
      // escape, so the common case is byte-for-byte what Vite emitted.
      expect(templateShell('src="/__PANEL_BASE__/a-b_c.js"', 'AbC-123_xyz')).toBe(
        'src="/AbC-123_xyz/a-b_c.js"',
      );
    });

    it('refuses an index.html that this build did not produce', async () => {
      // Under `tsx` the default client directory resolves to `src/client`, whose
      // `index.html` has no sentinel in it and whose script tag is `/main.tsx`. Serving that
      // would be a page that loads nothing, with a 404 for a file that has never existed in
      // a built tree. The sentinel is what makes the difference detectable.
      expect(loadShell('/definitely/not/here', 'p')).toEqual({ html: null, fault: 'missing' });
      expect(templateShell('<a href="/__PANEL_BASE__/x">', 'p')).toBe('<a href="/p/x">');
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
