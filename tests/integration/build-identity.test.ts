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
 * Build identity: a short commit SHA from a documented env var, or null.
 *
 * - Prefers a real commit SHA from env vars, shortened to 7 characters.
 * - Null when no documented source is available (no timestamp fallback).
 * - Never crashes when every source is absent.
 * - Exposed ONLY behind authentication (on `GET /api/auth/me`).
 * - Never on /healthz, never in the pre-login shell, never in a response
 *   header, and never in an outbound notification.
 */

describe('build identity', () => {
  describe('resolution', () => {
    it('buildId is either a string or null', () => {
      expect(
        typeof BUILD_IDENTITY.buildId === 'string' || BUILD_IDENTITY.buildId === null,
      ).toBe(true);
    });

    it('when non-null, buildId is at most 7 characters', () => {
      if (BUILD_IDENTITY.buildId !== null) {
        expect(BUILD_IDENTITY.buildId.length).toBeLessThanOrEqual(7);
      }
    });

    it('source is either "env" or "none"', () => {
      expect(BUILD_IDENTITY.source === 'env' || BUILD_IDENTITY.source === 'none').toBe(true);
    });

    it('in test environment (no Railway vars), buildId is null', () => {
      expect(BUILD_IDENTITY.buildId).toBeNull();
      expect(BUILD_IDENTITY.source).toBe('none');
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
      const body = JSON.parse(res.payload) as { buildId?: string | null };
      // In test env, buildId is null. The field must be present in the response.
      expect(body).toHaveProperty('buildId');
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
