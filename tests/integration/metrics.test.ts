import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_COOKIE,
  createAuthTestServer,
  enrollAccount,
  postLogin,
  type AuthTestContext,
} from '../helpers/auth-harness.js';
import type { MetricsResponse } from '../../src/shared/types.js';

/**
 * `GET /api/metrics` — the endpoint, not the arithmetic.
 *
 * The parsing and the two-sample CPU calculation are pinned in
 * `tests/unit/resources.test.ts` against fixture cgroup files. What is asserted here is
 * everything that is a property of the *route*: who may read it, that the body carries
 * no formatted string, that two requests inside one cadence window cost one reading,
 * and that it is inside the rate limiter rather than exempt from it.
 */
let ctx: AuthTestContext;
let cgroupRoot: string;

function fixtureCgroup(): string {
  const dir = mkdtempSync(join(tmpdir(), 'panel-metrics-cg-'));
  writeFileSync(join(dir, 'cgroup.controllers'), 'cpuset cpu io memory pids\n');
  writeFileSync(join(dir, 'memory.current'), '536870912\n');
  writeFileSync(join(dir, 'memory.max'), '1073741824\n');
  writeFileSync(join(dir, 'cpu.max'), '200000 100000\n');
  writeFileSync(join(dir, 'cpu.stat'), 'usage_usec 1000000\n');
  return dir;
}

afterEach(async () => {
  if (ctx) await ctx.cleanup();
  if (cgroupRoot) rmSync(cgroupRoot, { recursive: true, force: true });
});

/** Every string value in the payload, with the path it was found at. */
function stringLeaves(value: unknown, path = ''): { path: string; value: string }[] {
  if (typeof value === 'string') return [{ path, value }];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    stringLeaves(child, path === '' ? key : `${path}.${key}`),
  );
}

describe('GET /api/metrics', () => {
  it('requires a full session — no session and a pre session are both 401', async () => {
    cgroupRoot = fixtureCgroup();
    ctx = await createAuthTestServer({}, { metrics: { cgroupRoot } });
    await enrollAccount(ctx);

    const anonymous = await ctx.app.inject({ method: 'GET', url: ctx.url('/api/metrics') });
    expect(anonymous.statusCode).toBe(401);

    // A pre session has passed one factor. The figures say how much memory the panel is
    // using and how full the volume is — reconnaissance, and not the kind a half-
    // authenticated client gets.
    const login = await postLogin(ctx);
    const pre = ctx.cookieFrom(login)!;
    const preSession = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/metrics'),
      cookies: { [SESSION_COOKIE]: pre },
    });
    expect(preSession.statusCode).toBe(401);
    expect(preSession.json()).toEqual({ error: 'Unauthorized' });
  });

  it('answers raw numbers and nulls, and no formatted string anywhere', async () => {
    cgroupRoot = fixtureCgroup();
    ctx = await createAuthTestServer({}, { metrics: { cgroupRoot } });
    const account = await enrollAccount(ctx);

    const res = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/metrics'),
      cookies: { [SESSION_COOKIE]: account.cookie },
    });
    expect(res.statusCode, res.body).toBe(200);

    const body = res.json() as MetricsResponse;
    expect(body.memory).toEqual({
      usedBytes: 536870912,
      limitBytes: 1073741824,
      source: 'cgroup2',
    });
    expect(body.cpu.quotaCores).toBe(2);
    expect(body.cpu.usageUsec).toBe(1000000);
    // One sample so far. Null, not a fabricated zero: a rate needs two readings, and a
    // zero here would render as an idle panel however busy it is.
    expect(body.cpu.percentOfQuota).toBeNull();
    expect(body.cpu.sampleWindowMs).toBeNull();
    expect(body.disk.totalBytes).toBeGreaterThan(0);
    expect(body.meta.containerized).toBe(true);
    expect(body.meta.cadenceMs).toBe(1000);
    // Phase 3's field is absent rather than an empty array, so "no attribution yet" and
    // "attribution says nothing is running" stay distinguishable.
    expect('perProject' in body).toBe(false);

    // The whole point of the shape: the client formats. `"512 MB / 1 GB"` is a
    // translated string — `۵۱۲ مگابایت` for this operator, with different digits, a
    // different decimal mark and a different separator — so the server must not build it.
    const strings = stringLeaves(body);
    expect(strings.map((s) => s.path).sort()).toEqual([
      'disk.path',
      'memory.source',
      'meta.sampledAt',
      'meta.source',
    ]);
    for (const { path, value } of strings) {
      expect(value, `${path} looks formatted`).not.toMatch(/%/);
      expect(value, `${path} carries a unit`).not.toMatch(/\d\s?(B|KB|MB|GB|TB|KiB|MiB|GiB)\b/);
    }
    expect(body.meta.sampledAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('is served from the sampler, which starts on the first request and not at boot', async () => {
    cgroupRoot = fixtureCgroup();
    ctx = await createAuthTestServer({}, { metrics: { cgroupRoot } });
    const account = await enrollAccount(ctx);

    // Nothing has polled yet, so nothing is ticking. An always-on timer would be a
    // wakeup a second on an idle panel with nobody looking at it.
    expect(ctx.app.metrics.running).toBe(false);
    expect(ctx.app.metrics.peek()).toBeNull();

    const get = (): Promise<{ statusCode: number; json(): unknown }> =>
      ctx.inject({
        method: 'GET',
        url: ctx.url('/api/metrics'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });

    const first = (await get()).json() as MetricsResponse;
    expect(ctx.app.metrics.running).toBe(true);
    const second = (await get()).json() as MetricsResponse;

    // The clock is the injected one and has not moved, so both requests are inside the
    // same cadence window: identical bodies, one reading. A second browser tab is free.
    expect(second).toEqual(first);
    expect(ctx.app.metrics.samples).toBe(1);
  });

  it('is inside the per-session rate limit rather than exempt from it', async () => {
    cgroupRoot = fixtureCgroup();
    // Three tokens, so the bucket can be emptied in three requests instead of 120.
    ctx = await createAuthTestServer(
      {},
      { metrics: { cgroupRoot }, rateLimit: { session: { capacity: 3, refillPerSecond: 1 } } },
    );
    const account = await enrollAccount(ctx);

    // Enrolment itself spends a token or two on the same session row, so the exact
    // position of the first 429 is not the assertion — that it arrives at all is.
    const codes: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await ctx.inject({
        method: 'GET',
        url: ctx.url('/api/metrics'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      codes.push(res.statusCode);
      if (res.statusCode === 429) {
        // Never `Retry-After: 0`, which invites a retry guaranteed to fail.
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      }
    }
    // Unlike `/healthz` this route is inside the base path and behind a session, so
    // neither exemption has a reason. A polling widget that runs away must be throttled
    // like anything else.
    expect(codes[0]).toBe(200);
    expect(codes.at(-1)).toBe(429);
  });
});
