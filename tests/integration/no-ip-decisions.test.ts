import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getDb } from '../../src/server/db.js';
import { SESSION_COOKIE } from '../../src/server/services/session.service.js';
import { TOTP_PERIOD_SECONDS } from '../../src/server/services/totp.service.js';
import {
  createAuthTestServer,
  enrollAccount,
  totpCodeAt,
  type AuthTestContext,
} from '../helpers/auth-harness.js';

const SERVER_ROOT = join(import.meta.dirname, '..', '..', 'src', 'server');

/**
 * The only two files allowed to read the client address.
 *
 * `utils/client-ip.ts` is the single choke point; everything else that wants the
 * address for display calls through it. `plugins/logger-redaction.ts` records it
 * as a field on the request log line, which is a log record, not a decision.
 *
 * Anything else appearing here is the finding, not the exemption. Widening this
 * list is the change a reviewer should be looking at.
 */
const IP_READERS = new Set(['utils/client-ip.ts', 'plugins/logger-redaction.ts']);

/**
 * Ways to get at the client address in this stack.
 *
 * `req.ip` and `req.ips` are Fastify's (trustProxy-aware, therefore
 * attacker-influenced) accessors; `remoteAddress` is the socket's; the header is
 * the raw thing behind both.
 */
const IP_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'req.ip / request.ip', pattern: /\b(?:req|request|_req)\s*\.\s*ips?\b/ },
  { name: 'remoteAddress', pattern: /\bremoteAddress\b/ },
  { name: 'x-forwarded-for', pattern: /x-forwarded-for/i },
  { name: 'socket.remote*', pattern: /\bsocket\s*\.\s*remote/ },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('M1.4 — nothing decides anything from the client IP', () => {
  let ctx: AuthTestContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  describe('statically', () => {
    it('reads the client address in exactly one place, plus the log serialiser', () => {
      const files = sourceFiles(SERVER_ROOT);
      expect(files.length).toBeGreaterThan(10);

      const offenders: string[] = [];
      for (const file of files) {
        const rel = relative(SERVER_ROOT, file).split('\\').join('/');
        if (IP_READERS.has(rel)) continue;

        const lines = readFileSync(file, 'utf-8').split('\n');
        for (const [index, line] of lines.entries()) {
          // Prose about the policy is the point of the policy; only code counts.
          const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
          for (const { name, pattern } of IP_PATTERNS) {
            if (pattern.test(code)) offenders.push(`${rel}:${index + 1} (${name}) ${code.trim()}`);
          }
        }
      }

      expect(offenders).toEqual([]);
    });

    it('has no lockout service file left behind', () => {
      const named = sourceFiles(SERVER_ROOT)
        .map((f) => relative(SERVER_ROOT, f).split('\\').join('/'))
        .filter((name) => /lockout/i.test(name));
      expect(named).toEqual([]);
    });

    it('has no lockout table', async () => {
      ctx = await createAuthTestServer();
      const tables = (
        getDb()
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((r) => r.name);

      expect(tables).not.toContain('lockouts');
      // The replacement is there, and it is keyed on nothing.
      expect(tables).toContain('auth_failures');
      const columns = (
        getDb().prepare('PRAGMA table_info(auth_failures)').all() as { name: string }[]
      ).map((c) => c.name);
      expect(columns).toEqual(['id', 'consecutive_failures', 'last_failure_at']);
      expect(columns).not.toContain('scope');
      expect(columns).not.toContain('ip');
    });

    it('never mentions a per-IP bucket, window, or counter in code', () => {
      const offenders: string[] = [];
      for (const file of sourceFiles(SERVER_ROOT)) {
        const rel = relative(SERVER_ROOT, file).split('\\').join('/');
        const lines = readFileSync(file, 'utf-8').split('\n');
        for (const [index, line] of lines.entries()) {
          const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
          if (/\b(?:lockout|lockUntil|locked_until|perIp|byIp|ipBucket)\b/.test(code)) {
            offenders.push(`${rel}:${index + 1} ${code.trim()}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  describe('behaviourally', () => {
    it('shares one counter across addresses, so rotating an address buys nothing', async () => {
      ctx = await createAuthTestServer();
      await enrollAccount(ctx);
      resetCounter();

      // Four failures, each from a different address.
      const addresses = ['203.0.113.1', '198.51.100.7', '192.0.2.44', '203.0.113.99'];
      for (const [index, address] of addresses.entries()) {
        ctx.sleep.reset();
        const res = await ctx.app.inject({
          method: 'POST',
          url: ctx.url('/api/auth/login'),
          headers: { 'x-forwarded-for': address },
          payload: { username: 'admin', password: 'wrong-password-here' },
        });
        expect(res.statusCode).toBe(401);
        expect(counter(), `after ${index + 1} attempts`).toBe(index + 1);
      }

      // The fourth failure was already delayed, and it came from an address that
      // had never been seen before. A per-IP counter would have given it a free
      // pass; there isn't one.
      expect(ctx.sleep.total()).toBe(500);

      // A fifth, from yet another address, is priced from the shared counter.
      ctx.sleep.reset();
      await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login'),
        headers: { 'x-forwarded-for': '2001:db8::1' },
        payload: { username: 'admin', password: 'wrong-password-here' },
      });
      expect(ctx.sleep.total()).toBe(1_000);
    });

    it('never locks an address out, however many failures it produces', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      // A counter far past anything a lockout would have triggered on.
      setCounter(50);

      // The correct credentials still work from the same address, just slowly.
      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
      const login = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login'),
        headers: { 'x-forwarded-for': '203.0.113.1' },
        payload: { username: 'admin', password: 'correct-horse-battery-staple' },
      });
      expect(login.statusCode).toBe(200);

      const totp = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login/totp'),
        headers: { 'x-forwarded-for': '203.0.113.1' },
        cookies: { [SESSION_COOKIE]: ctx.cookieFrom(login)! },
        payload: { code: totpCodeAt(account.secret, ctx.clock.now()) },
      });
      expect(totp.statusCode).toBe(200);
      expect(counter()).toBe(0);
    });

    it('answers identically whatever the address claims to be', async () => {
      ctx = await createAuthTestServer();
      await enrollAccount(ctx);
      resetCounter();

      const bodies = new Set<string>();
      for (const address of ['203.0.113.1', '', 'not-an-address', '2001:db8::1', '127.0.0.1']) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: ctx.url('/api/auth/login'),
          ...(address === '' ? {} : { headers: { 'x-forwarded-for': address } }),
          payload: { username: 'admin', password: 'wrong-password-here' },
        });
        expect(res.statusCode, address).toBe(401);
        bodies.add(res.body);
      }
      expect(bodies.size).toBe(1);
    });

    it('still records the address as display-only metadata', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);

      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
      const login = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login'),
        headers: { 'x-forwarded-for': '203.0.113.77', 'user-agent': 'curl/8.0' },
        payload: { username: 'admin', password: 'correct-horse-battery-staple' },
      });
      expect(login.statusCode).toBe(200);

      const list = await ctx.app.inject({
        method: 'GET',
        url: ctx.url('/api/sessions'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      const { sessions } = list.json() as { sessions: { ip: string | null; userAgent: string | null }[] };
      expect(sessions.some((s) => s.ip === '203.0.113.77')).toBe(true);
      expect(sessions.some((s) => s.userAgent === 'curl/8.0')).toBe(true);

      // And in the audit log, as a column rather than as a decision input.
      const actors = (
        getDb().prepare('SELECT DISTINCT actor_ip AS ip FROM audit_log').all() as {
          ip: string | null;
        }[]
      ).map((r) => r.ip);
      expect(actors).toContain('203.0.113.77');
    });
  });
});

function counter(): number {
  return (
    getDb()
      .prepare('SELECT consecutive_failures AS c FROM auth_failures WHERE id = 1')
      .get() as { c: number }
  ).c;
}

function setCounter(value: number): void {
  getDb().prepare('UPDATE auth_failures SET consecutive_failures = ? WHERE id = 1').run(value);
}

function resetCounter(): void {
  setCounter(0);
}
