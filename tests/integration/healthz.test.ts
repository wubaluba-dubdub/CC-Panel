import { describe, it, expect, afterEach } from 'vitest';
import { getDb } from '../../src/server/db.js';
import {
  createHealthProbe,
  shippedMigrationCount,
} from '../../src/server/routes/healthz.js';
import {
  createLogCapture,
  createTestServer,
  type LogCapture,
  type TestContext,
} from '../helpers/test-server.js';

/**
 * `GET /healthz`.
 *
 * The endpoint Railway decides deployments with: it polls until it gets a 200 and only
 * then makes the new deployment live, and it does not poll again afterwards. That makes
 * the two directions asymmetric — failing during boot costs a deployment and leaves the
 * previous one up, while a premature 200 pushes a broken deployment live and nothing
 * notices until a human does — so M1.6 made the probe assert a bounded database read on
 * top of reachability. The reasoning is in `src/server/routes/healthz.ts`.
 *
 * What it must never do is say anything. It is unauthenticated, outside the base path,
 * and reachable by anyone who can reach the panel at all.
 */
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

  it('is not cacheable, so a stale 200 cannot outlive the thing it described', async () => {
    ctx = await createTestServer();

    const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('needs neither the base path nor a session', async () => {
    // The whole point of the route. It is mounted outside the prefix so a prober that
    // has never been told the secret can reach it, and Docker's own HEALTHCHECK does
    // exactly that.
    ctx = await createTestServer({ PANEL_BASE_PATH: 'somesecret' });

    const bare = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(bare.statusCode).toBe(200);

    // And it is not reachable *inside* the prefix, which would put the secret into the
    // healthcheck configuration of whatever is polling it.
    const prefixed = await ctx.app.inject({ method: 'GET', url: '/somesecret/healthz' });
    expect(prefixed.statusCode).toBe(404);
  });
});

describe('the probe answers 503 rather than 200 when the database is not usable', () => {
  let ctx: TestContext | null = null;
  let log: LogCapture | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
      ctx = null;
    }
    log = null;
  });

  it('fails when the schema table cannot be read at all', async () => {
    log = createLogCapture();
    ctx = await createTestServer({}, { logTarget: log.target });
    expect((await ctx.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);

    // The realistic shape of this is a detached volume or a restored-over file, neither
    // of which a test can stage. Dropping the table produces the same failure through
    // the same path: the read throws and the probe must not translate that into a 200.
    getDb().exec('DROP TABLE schema_migrations');

    const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('{"ok":false}');

    // The reason is logged and not sent. This endpoint is unauthenticated.
    expect(log.text()).toContain('health check failed');
    expect(log.text()).toContain('database unreadable');
    expect(res.body).not.toContain('schema_migrations');
    expect(res.body).not.toContain('unreadable');
  });

  it('fails when the database is only partly migrated', async () => {
    log = createLogCapture();
    ctx = await createTestServer({}, { logTarget: log.target });

    // A database that stopped halfway through a migration run serves happily until
    // something touches the missing table. Railway would have taken the 200 and made
    // the deployment live.
    getDb().prepare('DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)').run();

    const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('{"ok":false}');
    expect(log.text()).toContain('migrations are applied');
  });

  it('carries the same security headers on the 503 as on the 200', async () => {
    ctx = await createTestServer();
    const ok = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    getDb().exec('DROP TABLE schema_migrations');
    const bad = await ctx.app.inject({ method: 'GET', url: '/healthz' });

    expect(ok.statusCode).toBe(200);
    expect(bad.statusCode).toBe(503);
    for (const header of [
      'content-security-policy',
      'x-content-type-options',
      'referrer-policy',
      'cache-control',
      'content-type',
    ]) {
      expect(bad.headers[header], header).toBe(ok.headers[header]);
    }
  });
});

describe('the probe as a pure function', () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
      ctx = null;
    }
  });

  it('counts the migrations this build ships, from the files on disk', () => {
    // Derived, not a literal: adding migration 009 raises the bar the probe holds the
    // database to, with nothing to remember to update.
    expect(shippedMigrationCount()).toBeGreaterThanOrEqual(8);
  });

  it('passes when every shipped migration is applied and fails when one is not', async () => {
    ctx = await createTestServer();
    const shipped = shippedMigrationCount();

    expect(createHealthProbe({ db: getDb(), expectedMigrations: shipped })()).toEqual({
      ok: true,
    });

    const verdict = createHealthProbe({ db: getDb(), expectedMigrations: shipped + 1 })();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain(`${shipped} of ${shipped + 1}`);
  });

  it('reports a thrown read as a failure rather than propagating it', async () => {
    // A probe that threw would reach the error handler and answer 500, which is a
    // different signal from "not healthy" and one a prober may treat differently.
    ctx = await createTestServer();
    const db = getDb();
    db.exec('DROP TABLE schema_migrations');

    const verdict = createHealthProbe({ db, expectedMigrations: 8 })();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/database unreadable/);
  });
});
