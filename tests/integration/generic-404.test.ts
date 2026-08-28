import { describe, it, expect, afterEach } from 'vitest';
import { createTestServer, type TestContext } from '../helpers/test-server.js';

describe('Generic 404 outside base path', () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
      ctx = null;
    }
  });

  it('returns identical 404 for /, /login, /api/health, and random paths', async () => {
    ctx = await createTestServer();

    const paths = ['/', '/login', '/api/health', '/random-path-xyz', '/admin', '/wp-login.php'];
    const responses = await Promise.all(
      paths.map((url) => ctx!.app.inject({ method: 'GET', url })),
    );

    for (const res of responses) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe('{"error":"Not Found"}');
    }

    // All bodies must be byte-identical
    const bodies = responses.map((r) => r.body);
    expect(new Set(bodies).size).toBe(1);
  });

  it('does not hint that a prefix exists', async () => {
    ctx = await createTestServer();

    const res = await ctx.app.inject({ method: 'GET', url: '/some-random-path' });
    expect(res.body).not.toContain('base');
    expect(res.body).not.toContain('prefix');
    expect(res.body).not.toContain('panel');
  });
});
