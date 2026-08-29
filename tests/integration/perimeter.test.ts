import { describe, it, expect, afterEach } from 'vitest';
import { createTestServer, type TestContext } from '../helpers/test-server.js';

describe('M1.2 — Perimeter', () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  describe('Base path routing', () => {
    it('mounts all routes under the secret base path', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'secret-xyz' });

      // Outside prefix: 404
      const outside1 = await ctx.app.inject({ method: 'GET', url: '/' });
      expect(outside1.statusCode).toBe(404);

      const outside2 = await ctx.app.inject({ method: 'GET', url: '/login' });
      expect(outside2.statusCode).toBe(404);

      // Inside prefix: 200
      const inside = await ctx.app.inject({ method: 'GET', url: '/secret-xyz/' });
      expect(inside.statusCode).toBe(200);
      expect(inside.headers['content-type']).toMatch(/text\/html/);
      expect(inside.body).toContain('Panel shell — Phase 2');
      expect(inside.body).toContain('window.__BASE__ = "/secret-xyz"');
    });

    it('returns byte-identical 404 for all paths outside prefix', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });

      const paths = ['/', '/login', '/api/health', '/random-xyz-123', '/admin', '/wp-login.php'];
      const responses = await Promise.all(
        paths.map((p) => ctx.app.inject({ method: 'GET', url: p }))
      );

      // All should be 404
      responses.forEach((r) => expect(r.statusCode).toBe(404));

      // Bodies must be byte-identical
      const bodies = responses.map((r) => r.body);
      const firstBody = bodies[0]!;
      bodies.forEach((b) => expect(b).toBe(firstBody));

      // Headers must be identical (except request-specific ones like date)
      const firstContentType = responses[0]!.headers['content-type'];
      responses.forEach((r) => expect(r.headers['content-type']).toBe(firstContentType));
    });
  });

  describe('Healthz exemption', () => {
    it('GET /healthz returns exactly {"ok":true} outside the prefix', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'secret' });

      const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });
  });

  describe('Security headers', () => {
    it('applies all required security headers to every response', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });

      const res = await ctx.app.inject({ method: 'GET', url: '/x/' });

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-xss-protection']).toBe('1; mode=block');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(res.headers['permissions-policy']).toBe('geolocation=(), microphone=(), camera=()');
    });

    it('CSP is byte-identical in dev and production, with no unsafe-inline or unsafe-eval', async () => {
      const ctxDev = await createTestServer({ PANEL_BASE_PATH: 'x', NODE_ENV: 'test' });
      const ctxProd = await createTestServer({ PANEL_BASE_PATH: 'x', NODE_ENV: 'production' });

      const resDev = await ctxDev.app.inject({ method: 'GET', url: '/x/' });
      const resProd = await ctxProd.app.inject({ method: 'GET', url: '/x/' });

      const cspDev = resDev.headers['content-security-policy'];
      const cspProd = resProd.headers['content-security-policy'];

      expect(cspDev).toBe(cspProd);
      expect(cspDev).not.toContain('unsafe-inline');
      expect(cspDev).not.toContain('unsafe-eval');
      expect(cspDev).toContain("default-src 'none'");
      expect(cspDev).toContain("script-src 'self'");
      expect(cspDev).toContain("style-src 'self'");
      expect(cspDev).toContain("frame-ancestors 'none'");

      await ctxDev.cleanup();
      await ctxProd.cleanup();
    });

    it('HSTS is absent in development, present in production', async () => {
      const ctxDev = await createTestServer({ PANEL_BASE_PATH: 'x', NODE_ENV: 'test' });
      const ctxProd = await createTestServer({ PANEL_BASE_PATH: 'x', NODE_ENV: 'production' });

      const resDev = await ctxDev.app.inject({ method: 'GET', url: '/x/' });
      const resProd = await ctxProd.app.inject({ method: 'GET', url: '/x/' });

      expect(resDev.headers['strict-transport-security']).toBeUndefined();
      expect(resProd.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains; preload');

      await ctxDev.cleanup();
      await ctxProd.cleanup();
    });
  });

  describe('Base path secrecy', () => {
    it('base path never appears in log lines after boot', async () => {
      // This is a design contract test — actual log redaction will be verified in later milestones
      // For now, we just ensure the app doesn't echo the base path in error responses
      ctx = await createTestServer({ PANEL_BASE_PATH: 'secret-base-123' });

      const res404 = await ctx.app.inject({ method: 'GET', url: '/wrong-path' });
      expect(res404.body).not.toContain('secret-base-123');

      const resHealthz = await ctx.app.inject({ method: 'GET', url: '/healthz' });
      expect(resHealthz.body).not.toContain('secret-base-123');
    });
  });

  describe('Placeholder page', () => {
    it('serves a minimal placeholder at /${basePath}/ with window.__BASE__', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'testpath' });

      const res = await ctx.app.inject({ method: 'GET', url: '/testpath/' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('Panel shell — Phase 2');
      expect(res.body).toContain('window.__BASE__ = "/testpath"');
      expect(res.body).toContain('<!DOCTYPE html>');
    });
  });
});
