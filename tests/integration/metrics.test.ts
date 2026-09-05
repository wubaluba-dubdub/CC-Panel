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
    ctx = await createAuthTestServer({}, { metrics: { cgroupRoot }, watchdog: { cgroupRoot } });
    const account = await enrollAccount(ctx);
    // One watchdog sample, so every string the block can carry is actually present and the
    // literal below is the complete set rather than the subset a never-sampled watcher has.
    ctx.app.watchdog.tick();

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
      // M2.1 folded the watchdog's status into this response, and every string it adds is
      // either an ISO-8601 timestamp or a **code from a closed set**. That is the same
      // rule as the numbers above and for the same reason: the interface is translated
      // client-side, so `"memory.max is the literal max"` in a JSON body is a sentence
      // that can only ever be English. This literal is what forces that conversation the
      // next time a field is added.
      //
      // Both rules are armed here, and `reason` is null exactly when a rule is armed — so
      // `watchdog.memory.reason` and `watchdog.disk.reason` are absent from this list and
      // present in the disarmed case below. The two literals differ by exactly those two
      // paths, which is the assertion that the null is meaningful.
      'watchdog.disk.state',
      'watchdog.memory.state',
      'watchdog.sampledAt',
      'watchdog.source',
    ]);
    expect(['below', 'above']).toContain(body.watchdog.memory.state);
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

  it('carries the watchdog block, with codes and no prose, and no route of its own', async () => {
    // Same session, same poll, no new line in `EXPECTED_ROUTE_TREE`. The reason it is here
    // rather than at `/api/watchdog` is the widget's: with the block in this response it
    // can say *memory alerts are off because this container reports no limit* instead of
    // drawing a gauge that silently means nothing.
    cgroupRoot = fixtureCgroup();
    ctx = await createAuthTestServer({}, { metrics: { cgroupRoot }, watchdog: { cgroupRoot } });
    const account = await enrollAccount(ctx);

    const res = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/metrics'),
      cookies: { [SESSION_COOKIE]: account.cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { watchdog } = res.json() as MetricsResponse;

    expect(watchdog.enabled).toBe(true);
    // The suite does not arm the real 30 s interval, and the block says so rather than
    // conflating *switched off* with *not started*.
    expect(watchdog.running).toBe(false);
    expect(watchdog.cadenceMs).toBe(30_000);
    expect(watchdog.clearWindowMs).toBe(30 * 60_000);
    expect(watchdog.memory.thresholdPercent).toBe(85);
    expect(watchdog.memory.clearPercent).toBe(75);
    expect(watchdog.disk.thresholdPercent).toBe(80);
    expect(watchdog.disk.clearPercent).toBe(70);
    expect(watchdog.oom).toEqual({ kills: null, baseline: false });

    // `bootCheck()` ran on a fresh data directory, so the previous run is *known* to have
    // been clean — which is a different fact from "nothing looked", and the two are not
    // spelled the same.
    expect(watchdog.previousRun.checked).toBe(true);
    expect(watchdog.previousRun.cleanShutdown).toBe(true);
    expect(watchdog.previousRun.detail).toBeNull();

    // The two consumers of `resources.service.ts` are distinguishable from outside the
    // process: this is the watchdog's own window, and `cpu.sampleWindowMs` is the
    // sampler's. Both are null here — one sample each — and neither is the other's.
    expect(watchdog.cpuSampleWindowMs).toBeNull();
  });

  it('says which rule is disarmed and why, in a code, when the container reports no limit', async () => {
    // `memory.max` holding the literal `max`. Not a big number and not zero: there is
    // nothing for a fraction to be a fraction of, so the rule alerts on nothing — and the
    // widget has to be able to say that instead of drawing a full bar or an empty one.
    cgroupRoot = mkdtempSync(join(tmpdir(), 'panel-metrics-nolimit-'));
    writeFileSync(join(cgroupRoot, 'cgroup.controllers'), 'cpuset cpu io memory pids\n');
    writeFileSync(join(cgroupRoot, 'memory.current'), '536870912\n');
    writeFileSync(join(cgroupRoot, 'memory.max'), 'max\n');

    ctx = await createAuthTestServer({}, { metrics: { cgroupRoot }, watchdog: { cgroupRoot } });
    const account = await enrollAccount(ctx);
    ctx.app.watchdog.tick();

    const res = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/metrics'),
      cookies: { [SESSION_COOKIE]: account.cookie },
    });
    const body = res.json() as MetricsResponse;
    expect(body.memory.limitBytes).toBeNull();
    expect(body.watchdog.memory.armed).toBe(false);
    expect(body.watchdog.memory.reason).toBe('no_limit');
    expect(body.watchdog.memory.percent).toBeNull();
    // Disk has a denominator whatever the cgroup says, so it is unaffected.
    expect(body.watchdog.disk.armed).toBe(true);
    expect(body.watchdog.disk.reason).toBeNull();

    // The other half of the exact literal above: a disarmed rule adds exactly one string,
    // and it is a code from a closed set rather than the sentence the widget will show.
    const strings = stringLeaves(body);
    expect(strings.map((leaf) => leaf.path).sort()).toEqual([
      'disk.path',
      'memory.source',
      'meta.sampledAt',
      'meta.source',
      'watchdog.disk.state',
      'watchdog.memory.reason',
      'watchdog.memory.state',
      'watchdog.sampledAt',
      'watchdog.source',
    ]);
    for (const { path, value } of strings) {
      expect(value, `${path} looks formatted`).not.toMatch(/%/);
      // Prose would pass a "no % and no unit" check, so the reason is asserted against the
      // closed set itself.
      if (path.endsWith('.reason')) {
        expect(['disabled', 'no_limit', 'unavailable'], path).toContain(value);
      }
    }
  });

  it('reports the switch, not the cgroup, when the watchdog is turned off', async () => {
    // With `PANEL_WATCHDOG_ENABLED` off nothing is sampled, so every other reason would be
    // a guess — and `unavailable` in particular would send the operator to look at the
    // container instead of at the setting they changed.
    cgroupRoot = fixtureCgroup();
    ctx = await createAuthTestServer(
      { PANEL_WATCHDOG_ENABLED: false },
      { metrics: { cgroupRoot }, watchdog: { cgroupRoot } },
    );
    const account = await enrollAccount(ctx);

    const res = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/metrics'),
      cookies: { [SESSION_COOKIE]: account.cookie },
    });
    const { watchdog } = res.json() as MetricsResponse;
    expect(watchdog.enabled).toBe(false);
    expect(watchdog.memory.reason).toBe('disabled');
    expect(watchdog.disk.reason).toBe('disabled');
    // One switch, one meaning: the run marker is not written either, so nothing looked at
    // the previous run and the block does not claim it was clean.
    expect(watchdog.previousRun).toEqual({ checked: false, cleanShutdown: null, detail: null });
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
