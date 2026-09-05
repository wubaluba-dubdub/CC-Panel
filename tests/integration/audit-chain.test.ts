import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { getDb } from '../../src/server/db.js';
import { SecretString } from '../../src/server/crypto.js';
import {
  AuditEvent,
  AuditMetaError,
  AuditService,
  type AuditVerification,
} from '../../src/server/services/audit.service.js';
import {
  SESSION_COOKIE,
  createAuthTestServer,
  enrollAccount,
  postLogin,
  type AuthTestContext,
} from '../helpers/auth-harness.js';

/**
 * The audit log's two independent integrity controls.
 *
 * Migration 008's triggers stop this connection from rewriting history at all;
 * the keyed hash chain catches an attacker who holds the database file and can
 * therefore drop both triggers with two statements. Every tampering test here
 * drops the triggers first — not to make the test pass, but because that is
 * precisely the attacker the chain exists for, and a chain test that ran with the
 * triggers still installed would be testing the triggers a second time.
 *
 * `initDb` is a module singleton, so exactly one server may be live at a time:
 * one per test, `afterEach` cleanup.
 */

interface RawRow {
  id: number;
  ts: string;
  event: string;
  actor_ip: string | null;
  user_agent: string | null;
  outcome: string;
  meta_json: string;
  prev_hash: string | null;
  row_hash: string | null;
}

function rows(): RawRow[] {
  return getDb().prepare('SELECT * FROM audit_log ORDER BY id ASC').all() as RawRow[];
}

function ids(): number[] {
  return rows().map((row) => row.id);
}

function count(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }).c;
}

function chainRow(): { anchor_hash: string; floor_hash: string; floor_id: number; trim_unlocked: number } {
  return getDb().prepare('SELECT * FROM audit_chain WHERE id = 1').get() as {
    anchor_hash: string;
    floor_hash: string;
    floor_id: number;
    trim_unlocked: number;
  };
}

/**
 * Removes both triggers, which is what an attacker with the file does first.
 *
 * From here on the *only* thing standing between them and rewritten history is
 * the HMAC they cannot compute without `PANEL_MASTER_KEY`.
 */
function dropTriggers(db: Database = getDb()): void {
  db.exec('DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;');
}

/** Enough rows to have a middle to tamper with, written through the real routes. */
async function seedRows(ctx: AuthTestContext): Promise<void> {
  await enrollAccount(ctx);
  await postLogin(ctx, { password: 'wrong-password-entirely' });
  await postLogin(ctx);
  expect(count()).toBeGreaterThan(3);
}

function verify(ctx: AuthTestContext): AuditVerification {
  return ctx.app.auth.audit.verify();
}

describe('M1.5 — the audit log is append-only through this connection', () => {
  let ctx: AuthTestContext;

  afterEach(async () => {
    if (ctx !== undefined) await ctx.cleanup();
  });

  it('refuses UPDATE and DELETE on a chained row, and the row survives both', async () => {
    ctx = await createAuthTestServer();
    await seedRows(ctx);
    const db = getDb();
    const target = rows()[1]!;

    expect(() =>
      db.prepare('UPDATE audit_log SET outcome = ? WHERE id = ?').run('failure', target.id),
    ).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_log WHERE id = ?').run(target.id)).toThrow(
      /append-only/,
    );
    // Not even the hash columns, which is the update an attacker would want most.
    expect(() =>
      db.prepare('UPDATE audit_log SET row_hash = NULL WHERE id = ?').run(target.id),
    ).toThrow(/append-only/);
    // Nor a blanket truncation.
    expect(() => db.exec('DELETE FROM audit_log')).toThrow(/append-only/);

    const after = rows()[1]!;
    expect(after).toEqual(target);
    expect(verify(ctx).ok).toBe(true);
  });

  it('lets an INSERT through — SQLite cannot chain — and the chain catches it', async () => {
    // The triggers deliberately do not police INSERT: a row is inserted before its
    // hash can be computed, because the hash covers the row's own AUTOINCREMENT id.
    // So a hand-written row lands, and lands *unchained*, which verification reports.
    ctx = await createAuthTestServer();
    await seedRows(ctx);

    const info = getDb()
      .prepare(
        `INSERT INTO audit_log (ts, event, actor_ip, user_agent, outcome, meta_json)
         VALUES (?, ?, NULL, NULL, ?, ?)`,
      )
      .run('2026-01-01T00:00:00.000Z', AuditEvent.LoginSuccess, 'success', '{}');
    const forgedId = Number(info.lastInsertRowid);

    const result = verify(ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unchained_row');
    expect(result.brokenAtId).toBe(forgedId);
  });
});

describe('M1.5 — the hash chain catches what the triggers cannot', () => {
  let ctx: AuthTestContext;

  afterEach(async () => {
    if (ctx !== undefined) await ctx.cleanup();
  });

  it('detects an edited column, and names the row', async () => {
    ctx = await createAuthTestServer();
    await seedRows(ctx);
    dropTriggers();

    const target = rows()[1]!;
    const before = verify(ctx);
    expect(before.ok).toBe(true);

    // Flipped rather than pinned, so the UPDATE is guaranteed to change the value.
    const flipped = target.outcome === 'success' ? 'failure' : 'success';
    getDb().prepare('UPDATE audit_log SET outcome = ? WHERE id = ?').run(flipped, target.id);

    const result = verify(ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('row_hash_mismatch');
    expect(result.brokenAtId).toBe(target.id);
    // Every row was still walked, so `checked` is a count and not a stopping point.
    expect(result.checked).toBe(before.checked);
  });

  it('detects a whitespace-only edit inside meta_json', async () => {
    // The hash covers the stored `meta_json` string, not a re-serialisation of the
    // parsed object, so a semantically identical edit is still a break.
    ctx = await createAuthTestServer();
    await seedRows(ctx);
    dropTriggers();

    const target = rows().find((row) => row.meta_json.length > 2)!;
    const padded = `${target.meta_json.slice(0, 1)} ${target.meta_json.slice(1)}`;
    expect(JSON.parse(padded)).toEqual(JSON.parse(target.meta_json));

    getDb().prepare('UPDATE audit_log SET meta_json = ? WHERE id = ?').run(padded, target.id);

    const result = verify(ctx);
    expect(result.reason).toBe('row_hash_mismatch');
    expect(result.brokenAtId).toBe(target.id);
  });

  it('detects a deleted row, at the row that pointed past it', async () => {
    ctx = await createAuthTestServer();
    await seedRows(ctx);
    dropTriggers();

    const all = ids();
    const removed = all[1]!;
    const successor = all[2]!;
    getDb().prepare('DELETE FROM audit_log WHERE id = ?').run(removed);

    const result = verify(ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('prev_hash_mismatch');
    expect(result.brokenAtId).toBe(successor);
    expect(ids()).not.toContain(removed);
  });

  it('detects two rows’ contents being swapped, because the hash covers the id', async () => {
    // The one an unkeyed per-row digest would miss: the multiset of contents is
    // unchanged and every hash still matches *some* row.
    ctx = await createAuthTestServer();
    await seedRows(ctx);
    dropTriggers();

    const all = rows();
    const [a, b] = [all[1]!, all[2]!];
    const swap = getDb().prepare(
      'UPDATE audit_log SET ts = ?, event = ?, outcome = ?, meta_json = ? WHERE id = ?',
    );
    swap.run(b.ts, b.event, b.outcome, b.meta_json, a.id);
    swap.run(a.ts, a.event, a.outcome, a.meta_json, b.id);

    const result = verify(ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('row_hash_mismatch');
    expect(result.brokenAtId).toBe(a.id);
  });

  it('detects a truncated head, which a self-consistent chain cannot', async () => {
    // Deleting the newest rows leaves a chain that walks perfectly from the floor.
    // The anchor stored outside the chain is the only thing that notices.
    ctx = await createAuthTestServer();
    await seedRows(ctx);
    dropTriggers();

    const all = ids();
    const newest = all[all.length - 1]!;
    const survivor = all[all.length - 2]!;
    getDb().prepare('DELETE FROM audit_log WHERE id = ?').run(newest);

    const result = verify(ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('head_mismatch');
    expect(result.brokenAtId).toBe(survivor);
    expect(result.head).toBe(chainRow().anchor_hash);
  });

  it('detects an emptied table', async () => {
    ctx = await createAuthTestServer();
    await seedRows(ctx);
    dropTriggers();
    getDb().exec('DELETE FROM audit_log');

    const result = verify(ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('head_mismatch');
    expect(result.brokenAtId).toBeNull();
    expect(result.checked).toBe(0);
  });

  it('refuses a forged row whose hash is a bare SHA-256 of the same inputs', async () => {
    // Why the chain is an HMAC. This attacker has everything except the master key:
    // the file, both triggers dropped, the exact canonical form, and write access to
    // `audit_chain` so they can move the anchor to their forged row.
    ctx = await createAuthTestServer();
    await seedRows(ctx);
    dropTriggers();

    const db = getDb();
    const prev = rows()[rows().length - 1]!.row_hash!;
    const ts = '2026-06-01T12:00:00.000Z';
    const info = db
      .prepare(
        `INSERT INTO audit_log (ts, event, actor_ip, user_agent, outcome, meta_json, prev_hash)
         VALUES (?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(ts, AuditEvent.LoginSuccess, 'success', '{}', prev);
    const forgedId = Number(info.lastInsertRowid);

    const canonical = JSON.stringify([
      forgedId,
      ts,
      AuditEvent.LoginSuccess,
      null,
      null,
      'success',
      '{}',
    ]);
    const forgedHash = createHash('sha256')
      .update(prev, 'utf8')
      .update('\n', 'utf8')
      .update(canonical, 'utf8')
      .digest('hex');

    db.prepare('UPDATE audit_log SET row_hash = ? WHERE id = ?').run(forgedHash, forgedId);
    db.prepare('UPDATE audit_chain SET anchor_hash = ? WHERE id = 1').run(forgedHash);

    const result = verify(ctx);
    expect(result.ok).toBe(false);
    // The chain links up and the anchor agrees; only the keyed hash disagrees.
    expect(result.reason).toBe('row_hash_mismatch');
    expect(result.brokenAtId).toBe(forgedId);
  });

  it('reports the first break when there is more than one', async () => {
    ctx = await createAuthTestServer();
    await seedRows(ctx);
    dropTriggers();

    const all = ids();
    const edit = getDb().prepare('UPDATE audit_log SET user_agent = ? WHERE id = ?');
    edit.run('later', all[3]!);
    edit.run('earlier', all[1]!);

    expect(verify(ctx).brokenAtId).toBe(all[1]);
  });
});

describe('M1.5 — retention leaves the chain verifiable', () => {
  let ctx: AuthTestContext;

  afterEach(async () => {
    if (ctx !== undefined) await ctx.cleanup();
  });

  /** A service with a cap small enough to trip on the tenth write rather than the 20 000th. */
  function capped(at: number): AuditService {
    return new AuditService({
      db: getDb(),
      clock: ctx.clock,
      basePath: ctx.app.basePath,
      maxRows: at,
      trimCheckEvery: 1,
    });
  }

  function writeMany(audit: AuditService, howMany: number): void {
    for (let i = 0; i < howMany; i += 1) {
      ctx.clock.advance(1_000);
      audit.write({
        event: AuditEvent.LoginFailure,
        outcome: 'failure',
        meta: { reason: 'bad_credentials', n: i },
      });
    }
  }

  it('checkpoints before it deletes, moves the floor, and still verifies', async () => {
    ctx = await createAuthTestServer();
    const audit = capped(6);
    writeMany(audit, 12);

    expect(count()).toBeLessThanOrEqual(6);

    const checkpoints = rows().filter((row) => row.event === AuditEvent.AuditTrimmed);
    expect(checkpoints.length).toBeGreaterThan(0);
    const checkpoint = checkpoints[checkpoints.length - 1]!;
    const meta = JSON.parse(checkpoint.meta_json) as {
      removed: number;
      throughId: number;
      cap: number;
    };
    expect(meta.cap).toBe(6);
    expect(meta.removed).toBeGreaterThan(0);
    // The checkpoint is written *before* the deletion, so its id is above the range
    // it describes: a gap with no checkpoint above it is tampering, not housekeeping.
    expect(checkpoint.id).toBeGreaterThan(meta.throughId);

    const result = audit.verify();
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.checked).toBe(count());
    // The floor moved off genesis, which is what keeps the survivors anchored.
    expect(result.floorId).toBeGreaterThan(0);
    expect(result.floor).not.toBe('genesis');
    expect(result.floorId).toBe(chainRow().floor_id);
    expect(ids()[0]).toBeGreaterThan(result.floorId);
  });

  it('relocks the DELETE trigger, so retention is not a permanent hole', async () => {
    ctx = await createAuthTestServer();
    writeMany(capped(4), 8);

    expect(chainRow().trim_unlocked).toBe(0);
    expect(() => getDb().prepare('DELETE FROM audit_log WHERE id = ?').run(ids()[0])).toThrow(
      /append-only/,
    );
  });

  it('does not let a legitimate trim excuse a hand-deletion above the floor', async () => {
    ctx = await createAuthTestServer();
    const audit = capped(5);
    writeMany(audit, 10);
    expect(audit.verify().ok).toBe(true);

    dropTriggers();
    const surviving = ids();
    getDb().prepare('DELETE FROM audit_log WHERE id = ?').run(surviving[0]!);

    const result = audit.verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('prev_hash_mismatch');
    expect(result.brokenAtId).toBe(surviving[1]);
  });

  it('does nothing when the table is under the cap', async () => {
    ctx = await createAuthTestServer();
    const audit = capped(50);
    writeMany(audit, 3);

    expect(audit.trim()).toEqual({ removed: 0, throughId: null });
    expect(count()).toBe(3);
    expect(rows().some((row) => row.event === AuditEvent.AuditTrimmed)).toBe(false);
  });

  it('never trims itself below the two-row floor, whatever the cap says', async () => {
    // A cap of zero would otherwise mean "delete the checkpoint you just wrote".
    ctx = await createAuthTestServer();
    const audit = capped(0);
    writeMany(audit, 5);

    expect(count()).toBe(2);
    expect(audit.verify().ok).toBe(true);
  });
});

describe('M1.5 — the audit query API', () => {
  let ctx: AuthTestContext;
  let cookie = '';
  /** Timestamps of the rows written last, in the order they were written. */
  let stamps: string[] = [];

  afterEach(async () => {
    if (ctx !== undefined) await ctx.cleanup();
  });

  async function get(path: string, over?: { cookie?: string | null }): Promise<{
    status: number;
    json: unknown;
  }> {
    const jar = over === undefined ? cookie : over.cookie;
    const res = await ctx.app.inject({
      method: 'GET',
      url: ctx.url(path),
      ...(jar === null || jar === undefined ? {} : { cookies: { [SESSION_COOKIE]: jar } }),
    });
    return { status: res.statusCode, json: res.statusCode === 200 ? res.json() : null };
  }

  interface Page {
    entries: { id: number; ts: string; event: string; outcome: string }[];
    nextCursor: number | null;
  }

  async function page(path: string): Promise<Page> {
    const res = await get(path);
    expect(res.status, path).toBe(200);
    return res.json as Page;
  }

  /** A server with a spread of events at distinct, known timestamps. */
  async function seedQueryable(): Promise<void> {
    ctx = await createAuthTestServer();
    const account = await enrollAccount(ctx);
    cookie = account.cookie;

    stamps = [];
    const events = [
      AuditEvent.LoginFailure,
      AuditEvent.TotpFailure,
      AuditEvent.LoginFailure,
      AuditEvent.SessionRevoked,
      AuditEvent.LoginSuccess,
    ] as const;
    for (const event of events) {
      // A minute apart, so the range filter has something to discriminate on: the
      // fake clock does not tick by itself.
      ctx.clock.advance(60_000);
      ctx.app.auth.audit.write({
        event,
        outcome: event === AuditEvent.LoginSuccess ? 'success' : 'failure',
        meta: { marker: event },
      });
      stamps.push(rows()[rows().length - 1]!.ts);
    }
  }

  it('requires a full session, on both routes', async () => {
    ctx = await createAuthTestServer();
    const account = await enrollAccount(ctx);

    for (const path of ['/api/audit', '/api/audit/verify']) {
      expect((await get(path, { cookie: null })).status, path).toBe(401);
      expect((await get(path, { cookie: 'not-a-real-token' })).status, path).toBe(401);
    }

    // A `pre` session has passed one factor. The log records every attempt and every
    // secret access, so it is exactly what a stolen password should not open.
    const login = await postLogin(ctx);
    const pre = ctx.cookieFrom(login)!;
    for (const path of ['/api/audit', '/api/audit/verify']) {
      expect((await get(path, { cookie: pre })).status, path).toBe(401);
      expect((await get(path, { cookie: account.cookie })).status, path).toBe(200);
    }
  });

  it('returns newest first and pages over every row exactly once', async () => {
    await seedQueryable();

    const all = await page('/api/audit?limit=200');
    expect(all.entries.length).toBe(count());
    expect(all.nextCursor).toBeNull();
    const descending = [...all.entries].sort((a, b) => b.id - a.id);
    expect(all.entries).toEqual(descending);

    const walked: number[] = [];
    let cursor: number | null = null;
    for (let guard = 0; guard < 50; guard += 1) {
      const query = cursor === null ? '/api/audit?limit=2' : `/api/audit?limit=2&cursor=${cursor}`;
      const next: Page = await page(query);
      expect(next.entries.length).toBeLessThanOrEqual(2);
      walked.push(...next.entries.map((entry) => entry.id));
      cursor = next.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(walked).toEqual(all.entries.map((entry) => entry.id));
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('filters by event, one name or several', async () => {
    await seedQueryable();

    const one = await page(`/api/audit?event=${AuditEvent.LoginFailure}&limit=200`);
    expect(one.entries.length).toBeGreaterThan(0);
    expect(one.entries.every((entry) => entry.event === AuditEvent.LoginFailure)).toBe(true);

    const two = await page(
      `/api/audit?event=${AuditEvent.LoginFailure}&event=${AuditEvent.TotpFailure}&limit=200`,
    );
    expect(two.entries.length).toBeGreaterThan(one.entries.length);
    expect(
      two.entries.every(
        (entry) =>
          entry.event === AuditEvent.LoginFailure || entry.event === AuditEvent.TotpFailure,
      ),
    ).toBe(true);

    const none = await page('/api/audit?event=nothing.matches.this&limit=200');
    expect(none.entries).toEqual([]);
    expect(none.nextCursor).toBeNull();
  });

  it('filters by an inclusive time range', async () => {
    await seedQueryable();

    const from = stamps[1]!;
    const to = stamps[3]!;
    const ranged = await page(`/api/audit?from=${from}&to=${to}&limit=200`);

    expect(ranged.entries.length).toBeGreaterThan(0);
    expect(ranged.entries.every((entry) => entry.ts >= from && entry.ts <= to)).toBe(true);
    // Inclusive at both ends.
    expect(ranged.entries.some((entry) => entry.ts === from)).toBe(true);
    expect(ranged.entries.some((entry) => entry.ts === to)).toBe(true);
    // And nothing outside it.
    const outside = await page('/api/audit?limit=200');
    expect(ranged.entries.length).toBeLessThan(outside.entries.length);
  });

  it('rejects a malformed query with a 400 and nothing else', async () => {
    await seedQueryable();

    for (const query of [
      '?limit=0',
      '?limit=201',
      '?limit=abc',
      '?cursor=0',
      '?cursor=-4',
      '?cursor=1.5',
      '?from=yesterday',
      '?to=2026-13-45',
      `?event=${'e'.repeat(65)}`,
    ]) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: ctx.url(`/api/audit${query}`),
        cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(res.statusCode, query).toBe(400);
      expect(res.json(), query).toEqual({ error: 'Bad Request', code: 'bad_request' });
    }
  });

  it('reports integrity over HTTP, before and after tampering', async () => {
    await seedQueryable();

    const clean = (await get('/api/audit/verify')).json as {
      ok: boolean;
      checked: number;
      reason: string | null;
      brokenAtId: number | null;
      floorId: number;
    };
    expect(clean.ok).toBe(true);
    expect(clean.reason).toBeNull();
    expect(clean.brokenAtId).toBeNull();
    expect(clean.checked).toBe(count());
    expect(clean.floorId).toBe(0);

    dropTriggers();
    const target = rows()[2]!;
    getDb()
      .prepare('UPDATE audit_log SET user_agent = ? WHERE id = ?')
      .run('tampered', target.id);

    const dirty = (await get('/api/audit/verify')).json as {
      ok: boolean;
      reason: string | null;
      brokenAtId: number | null;
      head: string;
    };
    expect(dirty.ok).toBe(false);
    expect(dirty.reason).toBe('row_hash_mismatch');
    expect(dirty.brokenAtId).toBe(target.id);
    // The report carries hashes, which are not secrets — but it must not be cached,
    // and it is computed fresh here rather than served from the earlier clean answer.
    expect(dirty.head).toBe(chainRow().anchor_hash);
  });
});

describe('M1.5 — audit metadata refuses to carry a credential', () => {
  let ctx: AuthTestContext;

  afterEach(async () => {
    if (ctx !== undefined) await ctx.cleanup();
  });

  it('throws on a SecretString, a non-primitive, and a credential-shaped string', async () => {
    ctx = await createAuthTestServer();
    const audit = ctx.app.auth.audit;
    const before = count();

    const rejected: [string, Record<string, unknown>][] = [
      ['a SecretString', { token: new SecretString('sk-ant-api03-abcdefghijklmnop') }],
      ['a nested object', { detail: { token: 'sk-ant-api03-abcdefghijklmnop' } }],
      ['an array', { attempts: [1, 2, 3] }],
      ['an anthropic key', { note: 'sk-ant-api03-abcdefghijklmnop' }],
      ['a github pat', { note: 'ghp_abcdefghijklmnopqrstuvwxyz01' }],
      ['a jwt', { note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g' }],
    ];

    for (const [label, meta] of rejected) {
      expect(
        () =>
          audit.write({
            event: AuditEvent.SecretRevealed,
            outcome: 'success',
            meta: meta as Record<string, string | number | boolean | null>,
          }),
        label,
      ).toThrow(AuditMetaError);
    }

    // A rejection writes nothing at all: the validation runs before the insert.
    expect(count()).toBe(before);
    expect(audit.verify().ok).toBe(true);
  });

  it('elides the base path from a string value it does accept', async () => {
    ctx = await createAuthTestServer();
    ctx.app.auth.audit.write({
      event: AuditEvent.SessionCreated,
      outcome: 'success',
      meta: { path: `/${ctx.app.basePath}/api/auth/login`, ok: true, nothing: null },
    });

    const newest = rows()[rows().length - 1]!;
    expect(newest.meta_json).not.toContain(ctx.app.basePath);
    expect(newest.meta_json).toContain('<base>');
    expect(ctx.app.auth.audit.verify().ok).toBe(true);
  });
});

/**
 * M1.6 part 1.2 — a break at the oldest row is reported as probably-not-a-tamper.
 *
 * `row_hash` is an HMAC under a subkey of `PANEL_MASTER_KEY`, so changing that key
 * invalidates every row at once and `verify()` reports the *first* of them. An
 * operator who restores a backup under a different key, or mistypes it, therefore
 * sees `row_hash_mismatch at id 1` on a log nobody has touched — and an alarm that
 * fires on a legitimate operation is an alarm that gets ignored the next time.
 *
 * The fix is not to weaken the check: the report is still `ok: false`, still names
 * the reason and the row. It is to say, at the one position where the innocent
 * reading is far more likely than the guilty one, which reading that is. A tamper
 * cannot present this way, because the attacker had to leave every row before the
 * one they edited alone.
 *
 * The panel has no key-rotation procedure. See *Key rotation* in `docs/SECURITY.md`.
 */
describe('M1.6 — verify() distinguishes a wrong key from a tamper', () => {
  let ctx: AuthTestContext | null = null;
  let keptDir: string | null = null;

  const KEY_A = Buffer.from('a'.repeat(32)).toString('base64');
  const KEY_B = Buffer.from('b'.repeat(32)).toString('base64');

  afterEach(async () => {
    if (ctx !== null) await ctx.cleanup();
    ctx = null;
    if (keptDir !== null) rmSync(keptDir, { recursive: true, force: true });
    keptDir = null;
  });

  it('hints at the key when the whole chain fails from the oldest surviving row', async () => {
    // The real scenario, not a simulation of it: rows written under one master key
    // and verified under another, across a restart on the same volume.
    const first = await createAuthTestServer({ PANEL_MASTER_KEY: KEY_A }, { keepDataDir: true });
    keptDir = first.dataDir;
    await seedRows(first);
    const oldest = ids()[0]!;
    expect(verify(first).ok).toBe(true);
    await first.cleanup();

    ctx = await createAuthTestServer(
      { PANEL_MASTER_KEY: KEY_B },
      { dataDir: keptDir, keepDataDir: true },
    );

    const result = verify(ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('row_hash_mismatch');
    expect(result.brokenAtId).toBe(oldest);
    expect(result.hint).toBe('wrong_key_or_genesis');
    // The report is unchanged in every other respect: it still walked the table and
    // it still says the log does not verify.
    expect(result.checked).toBe(count());
  });

  it('gives no hint for a tamper partway down the chain', async () => {
    ctx = await createAuthTestServer();
    await seedRows(ctx);
    expect(verify(ctx).hint).toBeNull();

    dropTriggers();
    const middle = rows()[2]!;
    getDb().prepare('UPDATE audit_log SET user_agent = ? WHERE id = ?').run('tampered', middle.id);

    const result = verify(ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('row_hash_mismatch');
    expect(result.brokenAtId).toBe(middle.id);
    // This is the shape an attacker produces, and it gets no excuse.
    expect(result.hint).toBeNull();
  });

  it('hints when the oldest row no longer points at the stored floor', async () => {
    ctx = await createAuthTestServer();
    await seedRows(ctx);
    const oldest = ids()[0]!;

    // The floor lives outside the chain, so this needs no trigger drop. It is what a
    // restore against a mismatched `audit_chain` row looks like — a genesis problem,
    // which is the other half of what the hint is named for.
    getDb().prepare("UPDATE audit_chain SET floor_hash = 'not-the-floor' WHERE id = 1").run();

    const result = verify(ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('prev_hash_mismatch');
    expect(result.brokenAtId).toBe(oldest);
    expect(result.hint).toBe('wrong_key_or_genesis');
  });

  it('never hints for an unchained row, because no key can produce a NULL hash', async () => {
    ctx = await createAuthTestServer();
    await seedRows(ctx);
    const oldest = ids()[0]!;

    dropTriggers();
    getDb().prepare('UPDATE audit_log SET row_hash = NULL WHERE id = ?').run(oldest);

    const result = verify(ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unchained_row');
    expect(result.brokenAtId).toBe(oldest);
    // A row inserted by hand is the only way to get here. That is a tamper.
    expect(result.hint).toBeNull();
  });

  it('never hints for a truncated head', async () => {
    ctx = await createAuthTestServer();
    await seedRows(ctx);

    dropTriggers();
    const newest = rows()[rows().length - 1]!;
    getDb().prepare('DELETE FROM audit_log WHERE id = ?').run(newest.id);

    const result = verify(ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('head_mismatch');
    expect(result.hint).toBeNull();
  });

  it('reports the hint through GET /api/audit/verify', async () => {
    ctx = await createAuthTestServer();
    // Not `seedRows`: it enrols too, and a second enrolment against an account that
    // already has two-factor on is refused.
    const account = await enrollAccount(ctx);
    await postLogin(ctx, { password: 'wrong-password-entirely' });
    expect(count()).toBeGreaterThan(3);

    const read = async (): Promise<{ ok: boolean; reason: string | null; hint: string | null }> => {
      const res = await ctx!.inject({
        method: 'GET',
        url: ctx!.url('/api/audit/verify'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      expect(res.statusCode).toBe(200);
      return res.json() as { ok: boolean; reason: string | null; hint: string | null };
    };

    const clean = await read();
    expect(clean.ok).toBe(true);
    expect(clean.hint).toBeNull();

    dropTriggers();
    getDb()
      .prepare('UPDATE audit_log SET user_agent = ? WHERE id = ?')
      .run('tampered', ids()[0]!);

    const dirty = await read();
    expect(dirty.ok).toBe(false);
    expect(dirty.reason).toBe('row_hash_mismatch');
    expect(dirty.hint).toBe('wrong_key_or_genesis');
  });
});
