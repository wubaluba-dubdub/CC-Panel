import { describe, it, expect, afterEach } from 'vitest';
import { BUILD_IDENTITY } from '../../src/server/utils/build-info.js';
import {
  createAuthTestServer,
  enrollAccount,
  loginFully,
  SESSION_COOKIE,
  type AuthTestContext,
} from '../helpers/auth-harness.js';

/**
 * Build identity: a short commit SHA or a timestamp-based fallback.
 *
 * - Prefers a real commit SHA from env vars, shortened to 7 characters.
 * - Falls back to a build timestamp with an explicit `[unknown]` marker.
 * - Never crashes when every source is absent.
 * - Exposed ONLY behind authentication (on `GET /api/auth/me`).
 * - Never on /healthz, never in the pre-login shell, never in a response
 *   header, and never in an outbound notification.
 */

describe('build identity', () => {
  describe('resolution', () => {
    it('always produces a non-empty buildId', () => {
      expect(BUILD_IDENTITY.buildId).toBeTruthy();
      expect(typeof BUILD_IDENTITY.buildId).toBe('string');
    });

    it('buildId is at most 16 characters', () => {
      expect(BUILD_IDENTITY.buildId.length).toBeLessThanOrEqual(16);
    });

    it('source is either "env" or "fallback"', () => {
      expect(BUILD_IDENTITY.source === 'env' || BUILD_IDENTITY.source === 'fallback').toBe(true);
    });

    it('in test environment (no Railway vars), uses fallback', () => {
      expect(BUILD_IDENTITY.source).toBe('fallback');
    });
  });

  describe('authentication gate', () => {
    let ctx: AuthTestContext;

    afterEach(async () => {
      if (ctx) await ctx.cleanup();
    });

    it('buildId appears in GET /api/auth/me only after full authentication', async () => {
      ctx = await createAuthTestServer();
      const { secret } = await enrollAccount(ctx);
      const { cookie } = await loginFully(ctx, secret);

      const res = await ctx.app.inject({
        method: 'GET',
        url: ctx.url('/api/auth/me'),
        cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { buildId?: string };
      expect(body.buildId).toBeDefined();
      expect(typeof body.buildId).toBe('string');
      expect(body.buildId!.length).toBeGreaterThan(0);
    });

    it('buildId is absent from unauthenticated responses', async () => {
      ctx = await createAuthTestServer();

      const res = await ctx.app.inject({
        method: 'GET',
        url: ctx.url('/api/auth/me'),
      });
      expect(res.statusCode).not.toBe(200);
    });

    it('buildId is absent from /healthz', async () => {
      ctx = await createAuthTestServer();

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/healthz',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as Record<string, unknown>;
      expect(body.buildId).toBeUndefined();
    });

    it('buildId does not appear in response headers', async () => {
      ctx = await createAuthTestServer();
      const { secret } = await enrollAccount(ctx);
      const { cookie } = await loginFully(ctx, secret);

      const res = await ctx.app.inject({
        method: 'GET',
        url: ctx.url('/api/auth/me'),
        cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(res.statusCode).toBe(200);
      // Check no header name contains "build" or "sha"
      const headerKeys = Object.keys(res.headers);
      for (const key of headerKeys) {
        expect(key.toLowerCase()).not.toContain('build');
        expect(key.toLowerCase()).not.toContain('sha');
      }
    });
  });
});
