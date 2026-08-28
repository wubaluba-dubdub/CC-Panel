import { describe, it, expect, afterEach } from 'vitest';
import { createTestServer, type TestContext } from '../helpers/test-server.js';

describe('GET /healthz', () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
      ctx = null;
    }
  });

  it('returns exactly {"ok":true}', async () => {
    ctx = await createTestServer();

    const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
  });

  it('returns no version, build info, or uptime', async () => {
    ctx = await createTestServer();

    const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    const body = JSON.parse(res.body);
    expect(Object.keys(body)).toEqual(['ok']);
  });
});
