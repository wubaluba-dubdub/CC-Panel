import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BODY_LIMIT_BYTES } from '../../src/server/app.js';
import { getDb } from '../../src/server/db.js';
import { AuditEvent } from '../../src/server/services/audit.service.js';
import { CSRF_HEADER, csrfTokenFor } from '../../src/server/services/csrf.service.js';
import { NOTIFICATION_RULES } from '../../src/server/services/notification-rules.js';
import { hashToken } from '../../src/server/services/session.service.js';
import { AUDIT_EVENTS, type AuditEventName, type ProjectDto } from '../../src/shared/types.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  authed,
  createAuthTestServer,
  enrollAccount,
  loginFully,
  postLogin,
  stepUp,
  type AuthTestContext,
  type EnrolledAccount,
} from '../helpers/auth-harness.js';
import { createLogCapture } from '../helpers/test-server.js';
import { curl, listenLoopback } from '../helpers/curl.js';
import { startFakeTelegram, type FakeTelegram } from '../helpers/fake-telegram.js';

/**
 * `M2.2 P4` — the project routes: perimeter, identity, audit, notification, secrecy.
 *
 * A distinctive base path, so "the prefix is not in this log line" is a real
 * assertion rather than a substring coincidence with a common word.
 */
const BASE = 'projroutes-k7wq2n-sentinel';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Well-formed and absent — the shape a real one has, which is the whole point. */
const ABSENT_UUID = '11111111-2222-3333-4444-555555555555';

/** Small buckets, so a test empties one in three requests instead of one hundred and twenty. */
const TINY = {
  anonymous: { capacity: 3, refillPerSecond: 0.5 },
  session: { capacity: 3, refillPerSecond: 4 },
};

let ctx: AuthTestContext;
let account: EnrolledAccount | null;
let fake: FakeTelegram | null;

afterEach(async () => {
  if (ctx) await ctx.cleanup();
  if (fake) await fake.close();
  ctx = undefined as unknown as AuthTestContext;
  account = null;
  fake = null;
});

async function enrol(): Promise<EnrolledAccount> {
  account = await enrollAccount(ctx);
  return account;
}

function cookie(): string {
  if (account === null) throw new Error('enrol() first');
  return account.cookie;
}

/** The two CSRF halves for a session token, computed the way the server computes them. */
function csrfPairFor(token: string): { header: string; cookie: string } {
  const session = ctx.app.auth.sessions.resolve(token);
  if (session === null) throw new Error('no session for that token');
  const value = csrfTokenFor(session.id, hashToken(token));
  return { header: value, cookie: value };
}

async function auditRows(event: string): Promise<Record<string, unknown>[]> {
  const res = await ctx.inject({
    method: 'GET',
    url: ctx.url(`/api/audit?event=${event}&limit=50`),
    cookies: { [SESSION_COOKIE]: cookie() },
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { entries: { meta: Record<string, unknown> }[] };
  return body.entries.map((entry) => entry.meta);
}

async function createProject(slug = 'a-b-c'): Promise<ProjectDto> {
  const res = await ctx.inject({
    method: 'POST',
    url: ctx.url('/api/projects'),
    cookies: { [SESSION_COOKIE]: cookie() },
    payload: { slug },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as ProjectDto;
}

/**
 * Makes `audit.write` throw for exactly one event — **after** the real append has
 * run, so the row and any observer side effect are genuinely inside the transaction
 * under test and have to be rolled back rather than merely never written.
 *
 * The patch is scoped to one event name because `plugins/origin-check.ts` also
 * calls `audit.write` from an `onRequest` hook, and failing that would fail the
 * request before the handler rather than the append inside it.
 *
 * Returns the restore function. Always call it in a `finally`.
 */
function failAuditAfter(event: AuditEventName): () => void {
  const audit = ctx.app.auth.audit;
  const original = audit.write.bind(audit);
  audit.write = (entry): void => {
    if (entry.event !== event) {
      original(entry);
      return;
    }
    original(entry);
    throw new Error(`injected audit failure for ${event}`);
  };
  return () => {
    audit.write = original;
  };
}

describe('M2.2 P4 — the perimeter around the project routes', () => {
  it('is unreachable without the base path, and a near-miss prefix is the same 404', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    await enrol();

    for (const url of [
      '/api/projects',
      // One character short, one character long, and case-different: all three are
      // collapsed onto the gate's constant sink before routing, which is what makes the
      // prefix un-guessable rather than merely long.
      `/${BASE.slice(0, -1)}/api/projects`,
      `/${BASE}x/api/projects`,
      `/${BASE.toUpperCase()}/api/projects`,
    ]) {
      const res = await ctx.app.inject({
        method: 'GET',
        url,
        cookies: { [SESSION_COOKIE]: cookie() },
      });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: 'Not Found', code: 'not_found' });
    }
  });

  it('answers an anonymous caller with 401 on every method', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });

    const probes: {
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      path: string;
      payload?: Record<string, unknown>;
    }[] = [
      { method: 'GET', path: '/api/projects' },
      { method: 'POST', path: '/api/projects', payload: { slug: 'a-b-c' } },
      { method: 'GET', path: `/api/projects/${ABSENT_UUID}` },
      { method: 'PATCH', path: `/api/projects/${ABSENT_UUID}`, payload: { slug: 'x-y-z' } },
      { method: 'DELETE', path: `/api/projects/${ABSENT_UUID}` },
    ];
    for (const probe of probes) {
      const res =
        probe.payload === undefined
          ? await ctx.app.inject({ method: probe.method, url: ctx.url(probe.path) })
          : await ctx.app.inject({
              method: probe.method,
              url: ctx.url(probe.path),
              payload: probe.payload,
            });
      expect(res.statusCode, `${probe.method} ${probe.path}`).toBe(401);
      expect(res.json(), `${probe.method} ${probe.path}`).toEqual({
        error: 'Unauthorized',
        code: 'unauthenticated',
      });
    }
  });

  it('answers a `pre` session with 401, matching the convention every other full route uses', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    const login = await postLogin(ctx);
    const pre = ctx.cookieFrom(login)!;

    const res = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/projects'),
      cookies: { [SESSION_COOKIE]: pre },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized', code: 'unauthenticated' });
  });

  it('rejects a mutation with no X-CSRF-Token header', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    await enrol();

    const res = await ctx.app.inject({
      method: 'POST',
      url: ctx.url('/api/projects'),
      cookies: { [SESSION_COOKIE]: cookie() },
      payload: { slug: 'a-b-c' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden', code: 'csrf_invalid' });
  });

  it('rejects another session’s CSRF pair, even when its cookie half and header agree', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    await enrol();
    const second = await loginFully(ctx, account!.secret);
    const foreign = csrfPairFor(second.cookie);

    const res = await ctx.app.inject({
      method: 'POST',
      url: ctx.url('/api/projects'),
      cookies: { [SESSION_COOKIE]: cookie(), [CSRF_COOKIE]: foreign.cookie },
      headers: { [CSRF_HEADER]: foreign.header },
      payload: { slug: 'a-b-c' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden', code: 'csrf_invalid' });
  });

  it('rejects a foreign Origin and a poisoned Host with a bare 403', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    await enrol();
    const pair = csrfPairFor(cookie());

    const foreignOrigin = await ctx.app.inject({
      method: 'POST',
      url: ctx.url('/api/projects'),
      cookies: { [SESSION_COOKIE]: cookie(), [CSRF_COOKIE]: pair.cookie },
      headers: { [CSRF_HEADER]: pair.header, origin: 'https://evil.example' },
      payload: { slug: 'a-b-c' },
    });
    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.json()).toEqual({ error: 'Forbidden', code: 'forbidden' });
    expect(foreignOrigin.body).not.toContain('origin_mismatch');
    expect(foreignOrigin.body).not.toContain('evil.example');

    const poisonedHost = await ctx.app.inject({
      method: 'GET',
      url: ctx.url('/api/projects'),
      cookies: { [SESSION_COOKIE]: cookie() },
      headers: { host: 'evil.example' },
    });
    expect(poisonedHost.statusCode).toBe(403);
    expect(poisonedHost.json()).toEqual({ error: 'Forbidden', code: 'forbidden' });
    expect(poisonedHost.body).not.toContain('host_mismatch');
    expect(poisonedHost.body).not.toContain('evil.example');
  });

  it('refuses DELETE until the session re-confirms, and then does it', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    const account2 = await enrol();
    const { uuid } = await createProject();

    const withoutStepUp = await ctx.inject({
      method: 'DELETE',
      url: ctx.url(`/api/projects/${uuid}`),
      cookies: { [SESSION_COOKIE]: account2.cookie },
    });
    expect(withoutStepUp.statusCode).toBe(403);
    expect(withoutStepUp.json()).toEqual({ error: 'Forbidden', code: 'step_up_required' });
    // Still there: the refusal happened before the handler ran.
    const still = await ctx.inject({
      method: 'GET',
      url: ctx.url(`/api/projects/${uuid}`),
      cookies: { [SESSION_COOKIE]: account2.cookie },
    });
    expect(still.statusCode).toBe(200);

    expect((await stepUp(ctx, account2.cookie, account2.secret)).statusCode).toBe(200);
    const withStepUp = await ctx.inject({
      method: 'DELETE',
      url: ctx.url(`/api/projects/${uuid}`),
      cookies: { [SESSION_COOKIE]: account2.cookie },
    });
    expect(withStepUp.statusCode).toBe(204);
    expect(withStepUp.body).toBe('');
  });

  it('charges the session bucket: the project routes are not exempt', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE }, { rateLimit: TINY });
    await enrol();
    // Refill whatever enrolment spent, so the count below starts from a full bucket.
    ctx.clock.advance(60_000);
    const asMe = authed(ctx.app, cookie());

    for (let i = 0; i < TINY.session.capacity; i += 1) {
      const res = await asMe({ method: 'GET', url: ctx.url('/api/projects') });
      expect(res.statusCode, `request ${i + 1}`).toBe(200);
    }
    const limited = await asMe({ method: 'GET', url: ctx.url('/api/projects') });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'Too Many Requests', code: 'rate_limited' });
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('rejects a body over the limit with 413 and nothing else', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    await enrol();

    const res = await ctx.inject({
      method: 'POST',
      url: ctx.url('/api/projects'),
      cookies: { [SESSION_COOKIE]: cookie() },
      payload: { slug: 'x'.repeat(BODY_LIMIT_BYTES + 1024) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'Payload Too Large', code: 'too_large' });
  });
});

describe('M2.2 P4 — a uuid in the path is validated before anything else runs', () => {
  it('answers a malformed uuid and an unknown uuid with the byte-identical 404', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    await enrol();

    const malformed = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/projects/not-a-uuid'),
      cookies: { [SESSION_COOKIE]: cookie() },
    });
    // Long enough that no uuid could be this, short enough that it is still this route's
    // parameter — Fastify's `maxParamLength` (100) stops a longer one one layer earlier,
    // and the next test says so rather than leaving the boundary unexamined.
    const overlong = await ctx.inject({
      method: 'GET',
      url: `${ctx.prefix}/api/projects/${'a'.repeat(99)}`,
      cookies: { [SESSION_COOKIE]: cookie() },
    });
    const unknown = await ctx.inject({
      method: 'GET',
      url: ctx.url(`/api/projects/${ABSENT_UUID}`),
      cookies: { [SESSION_COOKIE]: cookie() },
    });

    for (const res of [malformed, overlong, unknown]) expect(res.statusCode).toBe(404);
    // Status *and* body, not just status: a 400 for "not uuid-shaped" would tell a caller
    // which of two things they got wrong, and would turn an unknown uuid into a probe for
    // the shape of a real one.
    expect(malformed.body).toBe(unknown.body);
    expect(overlong.body).toBe(unknown.body);
    expect(malformed.json()).toEqual({ error: 'Not Found', code: 'not_found' });
    expect(malformed.body).not.toContain('uuid');
    expect(malformed.body).not.toContain('not-a-uuid');
  });

  it('answers a segment past Fastify\u2019s maxParamLength with the ordinary unknown-project 404', async () => {
    // `maxParamLength` defaults to 100, so a longer parameter never reaches the
    // route above: find-my-way refuses it during traversal and Fastify answers
    // through `frameworkErrors`, before `setErrorHandler`, before every hook and
    // before routing resolves anything. Until this correction the framework wrote
    // that answer itself — `414`, a body quoting the raw path (secret prefix
    // included) and not one security header. The contract now is the panel's own:
    // byte-identical to an absent uuid, on every route with a parameter, with the
    // header set applied by the same function the `onSend` hook uses.
    const logCapture = createLogCapture();
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE }, { logTarget: logCapture.target });
    await enrol();

    // The reference answer, from the route itself.
    const unknown = await ctx.inject({
      method: 'GET',
      url: ctx.url(`/api/projects/${ABSENT_UUID}`),
      cookies: { [SESSION_COOKIE]: cookie() },
    });
    expect(unknown.statusCode).toBe(404);

    const incoming = (): number =>
      logCapture.lines().filter((line) => line.msg === 'incoming request').length;
    const before = incoming();

    const long = 'a'.repeat(150);
    // Two routes, because the fix lives at the Fastify factory: covering only the
    // route under review would not show that it is app-wide, and
    // `/api/notifications/queue/:id` is a pre-existing parameter of a different
    // resource entirely.
    for (const path of [`/api/projects/${long}`, `/api/notifications/queue/${long}`]) {
      const res = await ctx.inject({
        method: 'GET',
        url: ctx.url(path),
        cookies: { [SESSION_COOKIE]: cookie() },
      });
      expect(res.statusCode, path).toBe(404);
      expect(res.body, path).toBe(unknown.body);
      expect(res.json(), path).toEqual({ error: 'Not Found', code: 'not_found' });
      expect(res.headers['content-type'], path).toBe('application/json; charset=utf-8');
      expect(res.headers['server'], path).toBeUndefined();
      expect(res.headers['x-powered-by'], path).toBeUndefined();
      // Anonymous, so it must not mint a session — the prompt's rule, and a place a
      // "helpfully uniform" handler could start setting a cookie it has no reason to.
      expect(res.headers['set-cookie'], path).toBeUndefined();
      // The security headers are applied here rather than by a hook, because the
      // synthetic reply Fastify builds carries a route context with `onSend: null`
      // and therefore runs none. The complete byte-for-byte map, in both
      // environments, is asserted in `perimeter.test.ts`.
      expect(res.headers['x-content-type-options'], path).toBe('nosniff');
      expect(res.headers['content-security-policy'], path).toContain("default-src 'none'");
    }

    // **Nothing logged for the rejection at all.** `incomingRequest` fires before
    // the handler and its `req` serialiser keeps everything after the elided prefix
    // — i.e. the over-long segment — so `logController` suppresses it. This restores
    // what Fastify did before `frameworkErrors` was set, rather than adding a line
    // that would then have to be scrubbed.
    expect(incoming(), 'a framework rejection logged an incoming request line').toBe(before);

    // And the sweep: neither the requested path, the prefix, the segment, nor the
    // framework's own wording — which quotes all three — in anything logged.
    const logged = logCapture.text();
    expect(logged.length, 'the logger captured nothing at all').toBeGreaterThan(0);
    for (const needle of [
      BASE,
      long,
      'exceeding the max param length',
      'FST_ERR_MAX_PARAM_LENGTH',
      'FST_ERR_BAD_URL',
    ]) {
      expect(logged.includes(needle), `log line leaked: ${needle}`).toBe(false);
    }
  });

  it('stops at Node\u2019s own request-line limit, and claims nothing about bytes it never received', async () => {
    // The honest outer boundary. `app.inject()` hands Fastify a synthetic request
    // and never runs Node's HTTP parser, so only a real socket can show where the
    // application's control actually begins: the parser refuses a request line plus
    // headers beyond `--max-http-header-size` (16 KiB by default) with a 431 of its
    // own, long before `routing()` — and therefore long before `frameworkErrors` —
    // is reached. The contract above covers every path that *arrives*; this is the
    // first one that does not.
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    const root = await listenLoopback(ctx.app);

    const beyond = await curl([`${root}/${BASE}/api/projects/${'a'.repeat(16 * 1024)}`]);
    expect(beyond.status).toBe(431);

    // And the longest input that does arrive still lands on the ordinary 404 over
    // the wire, with no library wording in the body.
    const reaching = await curl([`${root}/${BASE}/api/projects/${'a'.repeat(150)}`]);
    expect(reaching.status).toBe(404);
    expect(reaching.body).toBe('{"error":"Not Found","code":"not_found"}');
    expect(reaching.body).not.toContain(BASE);
    expect(reaching.body).not.toContain('max param length');
  });

  it('treats uuid case as irrelevant, and never 400s where 404 is the only answer', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    await enrol();
    const { uuid } = await createProject();

    // Lowercase is what the store writes; the upper-case spelling finds the same row.
    const upper = await ctx.inject({
      method: 'GET',
      url: ctx.url(`/api/projects/${uuid.toUpperCase()}`),
      cookies: { [SESSION_COOKIE]: cookie() },
    });
    expect(upper.statusCode).toBe(200);
    expect((upper.json() as ProjectDto).uuid).toBe(uuid);

    // An unknown upper-case uuid is still just "no such project".
    const missingUpper = await ctx.inject({
      method: 'GET',
      url: ctx.url(`/api/projects/${ABSENT_UUID.toUpperCase()}`),
      cookies: { [SESSION_COOKIE]: cookie() },
    });
    const missingLower = await ctx.inject({
      method: 'GET',
      url: ctx.url(`/api/projects/${ABSENT_UUID}`),
      cookies: { [SESSION_COOKIE]: cookie() },
    });
    expect(missingUpper.statusCode).toBe(404);
    expect(missingUpper.body).toBe(missingLower.body);
  });
});

describe('M2.2 P4 — the five routes', () => {
  it('creates with 201, lists, reads, patches, and deletes with 204', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    await enrol();

    const dto = await createProject();
    expect(dto.uuid).toMatch(UUID);
    expect(dto.slug).toBe('a-b-c');
    expect(dto.renamed).toBe(false);
    expect(dto.isolatedSettings).toBe(false);
    // Exactly the columns migration 012 owns. Nothing about where this lives on disk, and
    // none of the seven M2.8 import columns.
    expect(Object.keys(dto).sort()).toEqual([
      'createdAt',
      'id',
      'isolatedSettings',
      'renamed',
      'slug',
      'updatedAt',
      'uuid',
    ]);

    const listed = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/projects'),
      cookies: { [SESSION_COOKIE]: cookie() },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ projects: [dto] });

    const read = await ctx.inject({
      method: 'GET',
      url: ctx.url(`/api/projects/${dto.uuid}`),
      cookies: { [SESSION_COOKIE]: cookie() },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(dto);

    // Slug only.
    const relabelled = await ctx.inject({
      method: 'PATCH',
      url: ctx.url(`/api/projects/${dto.uuid}`),
      cookies: { [SESSION_COOKIE]: cookie() },
      payload: { slug: 'a-new-name' },
    });
    expect(relabelled.statusCode, relabelled.body).toBe(200);
    const afterSlug = relabelled.json() as ProjectDto;
    expect(afterSlug.slug).toBe('a-new-name');
    expect(afterSlug.uuid).toBe(dto.uuid);
    expect(afterSlug.renamed).toBe(false);
    expect(afterSlug.createdAt).toBe(dto.createdAt);

    // Settings only, and the slug is untouched by it.
    const toggled = await ctx.inject({
      method: 'PATCH',
      url: ctx.url(`/api/projects/${dto.uuid}`),
      cookies: { [SESSION_COOKIE]: cookie() },
      payload: { isolatedSettings: true },
    });
    expect(toggled.statusCode).toBe(200);
    const afterToggle = toggled.json() as ProjectDto;
    expect(afterToggle.isolatedSettings).toBe(true);
    expect(afterToggle.slug).toBe('a-new-name');

    expect((await stepUp(ctx, cookie(), account!.secret)).statusCode).toBe(200);
    const removed = await ctx.inject({
      method: 'DELETE',
      url: ctx.url(`/api/projects/${dto.uuid}`),
      cookies: { [SESSION_COOKIE]: cookie() },
    });
    expect(removed.statusCode).toBe(204);

    const gone = await ctx.inject({
      method: 'GET',
      url: ctx.url(`/api/projects/${dto.uuid}`),
      cookies: { [SESSION_COOKIE]: cookie() },
    });
    expect(gone.statusCode).toBe(404);
    const emptied = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/projects'),
      cookies: { [SESSION_COOKIE]: cookie() },
    });
    expect(emptied.json()).toEqual({ projects: [] });
  });

  it('suffixes a colliding slug and says so in the DTO and in the audit row', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    await enrol();

    const first = await createProject();
    expect(first.slug).toBe('a-b-c');
    expect(first.renamed).toBe(false);

    const second = await createProject();
    expect(second.slug).toBe('a-b-c-2');
    expect(second.renamed).toBe(true);

    // The row records the slug that was *stored*, so the log and the DTO agree.
    const rows = await auditRows('project.created');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ slug: 'a-b-c-2', renamed: true });
    expect(rows[1]).toMatchObject({ slug: 'a-b-c', renamed: false });
  });

  it('rejects a bad slug and an empty PATCH with 400, and writes no lifecycle row', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    await enrol();

    const badCreate = await ctx.inject({
      method: 'POST',
      url: ctx.url('/api/projects'),
      cookies: { [SESSION_COOKIE]: cookie() },
      payload: { slug: 'BAD_SLUG!' },
    });
    expect(badCreate.statusCode).toBe(400);
    expect(badCreate.json()).toEqual({ error: 'Bad Request', code: 'bad_request' });

    const { uuid } = await createProject();

    const emptyPatch = await ctx.inject({
      method: 'PATCH',
      url: ctx.url(`/api/projects/${uuid}`),
      cookies: { [SESSION_COOKIE]: cookie() },
      payload: {},
    });
    expect(emptyPatch.statusCode).toBe(400);
    expect(emptyPatch.json()).toEqual({ error: 'Bad Request', code: 'bad_request' });

    // An invalid slug is refused by the route's own grammar check, before the service
    // is called at all — so it is the second half of "an empty or invalid PATCH writes
    // no project event", and it fails for a different reason than the empty body does.
    const badSlugPatch = await ctx.inject({
      method: 'PATCH',
      url: ctx.url(`/api/projects/${uuid}`),
      cookies: { [SESSION_COOKIE]: cookie() },
      payload: { slug: 'NOT A SLUG' },
    });
    expect(badSlugPatch.statusCode).toBe(400);
    expect(badSlugPatch.json()).toEqual({ error: 'Bad Request', code: 'bad_request' });

    expect(await auditRows('project.created')).toHaveLength(1);
    expect(await auditRows('project.updated')).toHaveLength(0);
    expect(await auditRows('project.deleted')).toHaveLength(0);
    expect(await auditRows('project.create_refused')).toHaveLength(0);
  });
});

describe('M2.2 P4 — what the audit row carries', () => {
  it('names the uuid and the slug, and never an address', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    const account2 = await enrol();
    const { uuid } = await createProject();

    const created = await auditRows('project.created');
    expect(created).toHaveLength(1);
    // The *complete* key set, not a subset: a fourth key is where an address or a path
    // would creep in, and an assertion of containment would not notice it.
    expect(Object.keys(created[0]!).sort()).toEqual(['renamed', 'slug', 'uuid']);
    expect(created[0]).toEqual({ uuid, slug: 'a-b-c', renamed: false });
    expect(JSON.stringify(created[0])).not.toMatch(/\d+\.\d+\.\d+\.\d+/);

    expect((await stepUp(ctx, account2.cookie, account2.secret)).statusCode).toBe(200);
    const deleted = await ctx.inject({
      method: 'DELETE',
      url: ctx.url(`/api/projects/${uuid}`),
      cookies: { [SESSION_COOKIE]: account2.cookie },
    });
    expect(deleted.statusCode).toBe(204);

    const rows = await auditRows('project.deleted');
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(['slug', 'uuid']);
    expect(rows[0]).toEqual({ uuid, slug: 'a-b-c' });
  });

  it('writes exactly one `project.updated` row for each of the three PATCH forms', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    await enrol();
    const { uuid } = await createProject();

    const patch = async (payload: Record<string, unknown>): Promise<ProjectDto> => {
      const res = await ctx.inject({
        method: 'PATCH',
        url: ctx.url(`/api/projects/${uuid}`),
        cookies: { [SESSION_COOKIE]: cookie() },
        payload,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as ProjectDto;
    };

    // The create wrote `project.created` and nothing else, so every row below is a PATCH.
    expect(await auditRows('project.updated')).toHaveLength(0);

    // ── Form 1: isolatedSettings only ────────────────────────────────────────
    expect((await patch({ isolatedSettings: true })).slug).toBe('a-b-c');
    expect(await auditRows('project.updated')).toHaveLength(1);

    // ── Form 2: slug only ────────────────────────────────────────────────────
    expect((await patch({ slug: 'd-e-f' })).slug).toBe('d-e-f');
    expect(await auditRows('project.updated')).toHaveLength(2);

    // ── Form 3: both fields ──────────────────────────────────────────────────
    const both = await patch({ slug: 'g-h-i', isolatedSettings: false });
    expect(both.slug).toBe('g-h-i');
    expect(both.isolatedSettings).toBe(false);
    // Exactly one row per successful mutation, so the route is not appending a
    // second one after the service returns.
    expect(await auditRows('project.updated')).toHaveLength(3);

    const rows = await auditRows('project.updated');
    // Newest first. Complete key set — a sixth key is where an address or a path
    // would creep in, and an assertion of containment would not notice it.
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'isolatedSettings',
      'previousSlug',
      'renamed',
      'slug',
      'uuid',
    ]);

    // `renamed` is *whether the label moved*, so a settings-only update says false
    // while both slug-bearing forms say true — including the one where the slug
    // stuck. `previousSlug` is what makes each row self-describing on its own.
    expect(rows[0]).toEqual({
      uuid,
      slug: 'g-h-i',
      previousSlug: 'd-e-f',
      isolatedSettings: false,
      renamed: true,
    });
    expect(rows[1]).toEqual({
      uuid,
      slug: 'd-e-f',
      previousSlug: 'a-b-c',
      isolatedSettings: true,
      renamed: true,
    });
    expect(rows[2]).toEqual({
      uuid,
      slug: 'a-b-c',
      previousSlug: 'a-b-c',
      isolatedSettings: true,
      renamed: false,
    });
  });

  it('records the disk-guard refusal with a closed reason and no figures', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    await enrol();

    const store = ctx.app.projectStore;
    const original = store.checkDisk.bind(store);
    store.checkDisk = () => ({ allowed: false, reason: 'above_threshold' });
    let res: Awaited<ReturnType<typeof ctx.inject>>;
    try {
      res = await ctx.inject({
        method: 'POST',
        url: ctx.url('/api/projects'),
        cookies: { [SESSION_COOKIE]: cookie() },
        payload: { slug: 'a-b-c' },
      });
    } finally {
      store.checkDisk = original;
    }

    expect(res.statusCode).toBe(507);
    expect(res.json()).toEqual({ error: 'Insufficient Storage', code: 'insufficient_storage' });
    // The figures a client must not learn are not in the body either.
    for (const leak of ['threshold', 'bytes', 'available', 'percent', 'projects/']) {
      expect(res.body, leak).not.toContain(leak);
    }

    const rows = await auditRows('project.create_refused');
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(['reason', 'slug', 'uuid']);
    expect(rows[0]).toMatchObject({ reason: 'disk_guard', slug: 'a-b-c' });
    expect(String(rows[0]!.uuid)).toMatch(UUID);

    // A refusal creates nothing: the identity the row names has no row of its own.
    const listed = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/projects'),
      cookies: { [SESSION_COOKIE]: cookie() },
    });
    expect(listed.json()).toEqual({ projects: [] });
  });
});

describe('M2.2 P4 — the closed sets the routes draw on', () => {
  const PROJECT_EVENTS = [
    AuditEvent.ProjectCreated,
    AuditEvent.ProjectUpdated,
    AuditEvent.ProjectDeleted,
    AuditEvent.ProjectCreateRefused,
  ] as const;

  it('uses exactly four project events, all present in the shared closed set', () => {
    // No fifth event, and no member missing.
    expect(AUDIT_EVENTS.filter((name) => name.startsWith('project.')).sort()).toEqual(
      [...PROJECT_EVENTS].sort(),
    );
    const shared = new Set<string>(AUDIT_EVENTS);
    for (const member of PROJECT_EVENTS) expect(shared.has(member), member).toBe(true);
    // The server's ergonomic keys are the same set as the canonical one, so a member
    // cannot exist in one and not the other.
    expect(new Set(Object.values(AuditEvent))).toEqual(shared);
  });

  it('has a notification rule for every project event, and only deletion notifies', () => {
    for (const member of PROJECT_EVENTS) {
      expect(
        Object.hasOwn(NOTIFICATION_RULES, member),
        `${member} has no rule — an event with no entry is a silent omission, not a decision`,
      ).toBe(true);
    }

    // The three silent ones are explicit `null`, not absent.
    expect(NOTIFICATION_RULES[AuditEvent.ProjectCreated]).toBeNull();
    expect(NOTIFICATION_RULES[AuditEvent.ProjectUpdated]).toBeNull();
    expect(NOTIFICATION_RULES[AuditEvent.ProjectCreateRefused]).toBeNull();
    expect(NOTIFICATION_RULES[AuditEvent.ProjectDeleted]).toEqual({
      throttleKey: 'project.deleted',
      throttleMs: 0,
    });
  });
});

describe('M2.2 P4 — the error-body sentinel', () => {
  it('drops a filesystem message, an errno and a fake secret from body and log alike', async () => {
    const logCapture = createLogCapture();
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE }, { logTarget: logCapture.target });
    await enrol();

    const DIR = '/data/projects/9f8e7d6c-0000-4000-8000-000000000001/claude-home';
    const SECRET = `sk-ant-api03-${randomBytes(16).toString('hex')}`;
    const NEEDLES = [DIR, SECRET, 'ENOSPC', 'settings.json', BASE];

    // The third leak class: not a thrown `HttpError` but a real filesystem failure whose
    // message quotes where the panel keeps things and what it was writing. Nothing in
    // production constructs this — the seam below is a test seam — but the route has to be
    // correct against the *shape* of that failure and not only against the errors it
    // happens to see today.
    const store = ctx.app.projectStore as unknown as { create(input: unknown): unknown };
    store.create = () => {
      const err = new Error(`write ${DIR}/settings.json: ${SECRET}`) as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      err.errno = -28;
      throw err;
    };

    const res = await ctx.inject({
      method: 'POST',
      url: ctx.url('/api/projects'),
      cookies: { [SESSION_COOKIE]: cookie() },
      payload: { slug: 'a-b-c' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error', code: 'server_error' });

    // Every log line this server emitted, from boot onward.
    const logged = logCapture.text();
    expect(logged.length, 'the logger captured nothing at all').toBeGreaterThan(0);
    for (const needle of NEEDLES) {
      expect(res.body.includes(needle), `response body leaked: ${needle}`).toBe(false);
      expect(logged.includes(needle), `log line leaked: ${needle}`).toBe(false);
    }
    // Not asserted over the response *headers*, which are neither the body nor a log
    // line: the session cookie's `Path` is one of the three places the prefix is
    // documented to travel, and a header sweep would be a claim the panel does not make.
    expect(res.headers['set-cookie']).toBeDefined();

    // The failure was still *reported*: a silent catch would pass the sweep above by
    // saying nothing at all, which is a different defect.
    expect(logged).toContain('project operation failed');
    expect(logged).toContain('"phase":"unknown"');
    // And the audit trail says a create was refused rather than leaving a 500 unexplained.
    expect(await auditRows('project.create_refused')).toHaveLength(0);
    expect((await auditRows('project.created'))).toHaveLength(0);
  });
});

describe('M2.2 P4 — the deletion message', () => {
  it('is plain text, names the slug unescaped, and carries no parse_mode and no URL', async () => {
    fake = await startFakeTelegram();
    ctx = await createAuthTestServer(
      { PANEL_BASE_PATH: BASE },
      { notify: { telegramBaseUrl: fake.baseUrl } },
    );
    const account2 = await enrol();

    const TOKEN = `123456789:AA${randomBytes(16).toString('hex')}`;
    const CHAT = '987654321';
    ctx.app.auth.secrets.set('telegram', 'bot_token', TOKEN);
    ctx.app.auth.secrets.set('telegram', 'chat_id', CHAT);

    // Enrolment queued its own alerts. Send them and start from a clean wire so the one
    // request below is the deletion and nothing else.
    await ctx.app.notify.drain();
    fake.requests.length = 0;

    // Step up *before* the drain: `step-up.granted` is itself a notified event, and a
    // queue holding it would be the row `tick()` claims first — the test would then be
    // asserting the wrong message perfectly.
    expect((await stepUp(ctx, account2.cookie, account2.secret)).statusCode).toBe(200);
    await ctx.app.notify.drain();
    fake.requests.length = 0;

    const { uuid } = await createProject();
    const deleted = await ctx.inject({
      method: 'DELETE',
      url: ctx.url(`/api/projects/${uuid}`),
      cookies: { [SESSION_COOKIE]: account2.cookie },
    });
    expect(deleted.statusCode).toBe(204);

    const attempt = await ctx.app.notify.tick();
    expect(attempt, 'the deletion did not produce a message').toMatchObject({ state: 'sent' });
    expect(fake.requests).toHaveLength(1);

    const request = fake.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.path).toBe(`/bot${TOKEN}/sendMessage`);

    // On the wire, not merely absent from the object the transport built. The standing
    // transport-level scan over `telegram.transport.ts` is
    // `tests/unit/telegram-transport.test.ts`; this is the same property observed on the
    // bytes for *this* message.
    expect(request.body).not.toContain('parse_mode');
    expect(Object.keys(request.json!)).not.toContain('parse_mode');
    expect(request.json!.chat_id).toBe(CHAT);

    const text = String(request.json!.text);
    const lines = text.split('\n');
    // Byte-identical and unescaped: the slug grammar has no Markdown control characters,
    // so there is nothing for an escaper to do and the value the operator typed is the
    // value that arrives. The fixture is `a-b-c` because `a_b-c` is not a valid slug.
    expect(lines[0]).toBe('Panel security — a project was deleted');
    expect(lines[1]).toBe('project: a-b-c');
    expect(text).toContain('a-b-c');
    expect(text).not.toContain('\\_');
    expect(text).not.toContain('\\*');
    expect(text).not.toContain('\\-');

    // Plain text and outbound-only: with links off there is no URL anywhere in the
    // message, so there is nothing to paste a token into and no base path to leak.
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain(BASE);

    // The stored event carries the subject, so a later transport can render it again
    // without re-reading the audit log.
    const stored = getDb()
      .prepare(
        "SELECT event_json FROM notification_queue WHERE kind = 'security_alert' ORDER BY id DESC LIMIT 1",
      )
      .get() as { event_json: string } | undefined;
    expect(stored).toBeDefined();
    const event = JSON.parse(stored!.event_json) as Record<string, unknown>;
    expect(event).toMatchObject({ kind: 'security_alert', event: 'project.deleted', subject: 'a-b-c' });
    expect(stored!.event_json).not.toContain('parse_mode');
  });
});

describe('M2.2 — a successful mutation and its audit row are one transaction', () => {
  /** Rows in the notification queue carrying a given audit event name. */
  function queuedFor(event: string): number {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM notification_queue WHERE event_json LIKE ?')
      .get(`%"${event}"%`) as { n: number };
    return row.n;
  }

  it('rolls a create back and quarantines the promoted tree when the append throws', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    await enrol();

    const restore = failAuditAfter(AuditEvent.ProjectCreated);
    let res: Awaited<ReturnType<typeof ctx.inject>>;
    try {
      res = await ctx.inject({
        method: 'POST',
        url: ctx.url('/api/projects'),
        cookies: { [SESSION_COOKIE]: cookie() },
        payload: { slug: 'a-b-c' },
      });
    } finally {
      restore();
    }

    // The generic safe server error, and nothing about the failure's origin.
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error', code: 'server_error' });

    // No success row, and no refusal row either: the disk guard never refused, and
    // `create_refused` means that and nothing else.
    expect(await auditRows('project.created')).toHaveLength(0);
    expect(await auditRows('project.create_refused')).toHaveLength(0);

    const listed = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/projects'),
      cookies: { [SESSION_COOKIE]: cookie() },
    });
    expect(listed.json()).toEqual({ projects: [] });

    // The one residue the rollback cannot undo is the tree `rename(2)` already put
    // under `projects/`. It follows the existing quarantine path rather than being
    // left as a rowless directory, and the uuid it names is the one the route
    // allocated — so nothing exists under `projects/` for a project with no row.
    const orphans = ctx.app.projectStore.listOrphans();
    expect(orphans).toHaveLength(1);
    const orphan = orphans[0]!;
    expect(orphan).toMatch(/^\.project-orphan-[0-9a-f-]{36}$/);
    const uuid = orphan.slice('.project-orphan-'.length);
    expect(existsSync(ctx.app.projectStore.projectDir(uuid))).toBe(false);
    expect(existsSync(join(ctx.dataDir, orphan))).toBe(true);
  });

  it('rolls a patch back completely when the append throws', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    await enrol();
    const { uuid } = await createProject();

    const restore = failAuditAfter(AuditEvent.ProjectUpdated);
    let res: Awaited<ReturnType<typeof ctx.inject>>;
    try {
      res = await ctx.inject({
        method: 'PATCH',
        url: ctx.url(`/api/projects/${uuid}`),
        cookies: { [SESSION_COOKIE]: cookie() },
        payload: { slug: 'd-e-f', isolatedSettings: true },
      });
    } finally {
      restore();
    }

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error', code: 'server_error' });
    // The attempted value is not in the response either: a generic 500 is all this
    // route is allowed to say, whether the database failed or the append did.
    expect(res.body).not.toContain('d-e-f');

    // Both fields exactly as they were — the update, not just the audit row, is gone.
    const after = ctx.app.projects.getByUuid(uuid);
    expect(after).not.toBeNull();
    expect(after!.slug).toBe('a-b-c');
    expect(after!.isolatedSettings).toBe(false);
    expect(await auditRows('project.updated')).toHaveLength(0);
  });

  it('keeps secrets, row and directory when a delete append throws, and queues nothing', async () => {
    ctx = await createAuthTestServer({ PANEL_BASE_PATH: BASE });
    await enrol();

    // A *successful* deletion first, so the queue assertion below is not vacuous:
    // it proves one row got in and the failed one did not add a second.
    const good = await createProject('e-f-g');
    const kept = await createProject('h-i-j');
    const keptScope = `project:${kept.uuid}`;
    ctx.app.auth.secrets.set(keptScope, 'hook_token', 'value-under-test');

    expect((await stepUp(ctx, cookie(), account!.secret)).statusCode).toBe(200);
    const ok = await ctx.inject({
      method: 'DELETE',
      url: ctx.url(`/api/projects/${good.uuid}`),
      cookies: { [SESSION_COOKIE]: cookie() },
    });
    expect(ok.statusCode).toBe(204);
    expect(await auditRows('project.deleted')).toHaveLength(1);
    expect(queuedFor('project.deleted')).toBe(1);

    const restore = failAuditAfter(AuditEvent.ProjectDeleted);
    let res: Awaited<ReturnType<typeof ctx.inject>>;
    try {
      res = await ctx.inject({
        method: 'DELETE',
        url: ctx.url(`/api/projects/${kept.uuid}`),
        cookies: { [SESSION_COOKIE]: cookie() },
      });
    } finally {
      restore();
    }

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error', code: 'server_error' });

    // All three database effects rolled back together — the row, and the secret
    // scope that only that row gave meaning to.
    expect(ctx.app.projects.getByUuid(kept.uuid)).not.toBeNull();
    expect(ctx.app.auth.secrets.get(keptScope, 'hook_token')).not.toBeNull();
    // The filesystem step never ran, because it is after the transaction.
    expect(existsSync(ctx.app.projectStore.projectDir(kept.uuid))).toBe(true);

    // Still one row from the successful deletion above, and still one queue entry:
    // `AuditService.#append` fires the observer before this test's `throw`, so the
    // queued row was written *inside* the transaction and had to go with it.
    expect(await auditRows('project.deleted')).toHaveLength(1);
    expect(queuedFor('project.deleted')).toBe(1);
  });
});
