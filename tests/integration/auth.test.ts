import { describe, it, expect, afterEach } from 'vitest';
import { getDb } from '../../src/server/db.js';
import { SINGLE_USER_ID } from '../../src/server/services/user.service.js';
import { MAX_DELAY_MS } from '../../src/server/services/auth-delay.service.js';
import { AuditEvent } from '../../src/server/services/audit.service.js';
import { TOTP_PERIOD_SECONDS } from '../../src/server/services/totp.service.js';
import {
  SESSION_COOKIE,
  TEST_PASSWORD,
  TEST_USERNAME,
  createAuthTestServer,
  enrollAccount,
  loginFully,
  postLogin,
  totpCodeAt,
  type AuthTestContext,
} from '../helpers/auth-harness.js';

describe('M1.4 — authentication', () => {
  let ctx: AuthTestContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  // ── First run ──────────────────────────────────────────────────────────────

  describe('first-run enrolment', () => {
    it('seeds exactly one user from the environment', async () => {
      ctx = await createAuthTestServer();

      const rows = getDb().prepare('SELECT id, username FROM users').all() as {
        id: number;
        username: string;
      }[];
      expect(rows).toEqual([{ id: SINGLE_USER_ID, username: TEST_USERNAME }]);
    });

    it('never stores the seeded password in plaintext', async () => {
      ctx = await createAuthTestServer();

      const row = getDb()
        .prepare('SELECT password_hash FROM users WHERE id = ?')
        .get(SINGLE_USER_ID) as { password_hash: string };

      expect(row.password_hash).not.toContain(TEST_PASSWORD);
      // 64 MiB, t=3, p=1, as specified.
      expect(row.password_hash.startsWith('$argon2id$v=19$m=65536,t=3,p=1$')).toBe(true);
    });

    it('does not re-seed or overwrite the password on a later boot', async () => {
      const first = await createAuthTestServer({}, { keepDataDir: true });
      const dataDir = first.dataDir;
      const originalHash = passwordHash();
      await first.cleanup();

      // Same volume, and a *different* password still sitting in the environment.
      ctx = await createAuthTestServer(
        { PANEL_ADMIN_PASSWORD: 'a-completely-different-password' },
        { dataDir },
      );

      expect(passwordHash()).toBe(originalHash);
      // The original password still works; the environment's does not.
      const good = await postLogin(ctx, { password: TEST_PASSWORD });
      expect(good.statusCode).toBe(200);
      const bad = await postLogin(ctx, { password: 'a-completely-different-password' });
      expect(bad.statusCode).toBe(401);
    });

    it('refuses to boot with no user and no admin credentials', async () => {
      const first = await createAuthTestServer({}, { keepDataDir: true });
      const dataDir = first.dataDir;
      // Drop the user, keep the volume: the state a wiped users table leaves.
      getDb().prepare('DELETE FROM users').run();
      await first.cleanup();

      await expect(
        createAuthTestServer(
          { PANEL_ADMIN_USERNAME: undefined, PANEL_ADMIN_PASSWORD: undefined },
          { dataDir, keepDataDir: false },
        ),
      ).rejects.toThrow(/no user exists and PANEL_ADMIN_USERNAME/);
    });

    it('walks password → enrol → confirm and hands back ten recovery codes once', async () => {
      ctx = await createAuthTestServer();

      const login = await postLogin(ctx);
      expect(login.statusCode).toBe(200);
      // Two-factor is not enrolled, so the next step is setup, not a code.
      expect(login.json()).toEqual({ stage: 'setup' });

      const account = await enrollAccount(ctx);
      expect(account.recoveryCodes).toHaveLength(10);

      const me = await ctx.app.inject({
        method: 'GET',
        url: ctx.url('/api/auth/me'),
        cookies: { [SESSION_COOKIE]: account.cookie },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        username: TEST_USERNAME,
        stage: 'authenticated',
        totpEnabled: true,
        stepUpActive: false,
        recoveryCodesRemaining: 10,
      });
    });

    it('writes a setup.completed audit row', async () => {
      ctx = await createAuthTestServer();
      await enrollAccount(ctx);

      const events = auditEvents();
      expect(events).toContain(AuditEvent.TwoFactorEnrollmentStarted);
      expect(events).toContain(AuditEvent.SetupCompleted);
      expect(events).toContain(AuditEvent.LoginSuccess);
    });
  });

  // ── Credential verification ────────────────────────────────────────────────

  describe('password verification', () => {
    it('answers identically for a wrong password and an unknown username', async () => {
      ctx = await createAuthTestServer();

      const wrongPassword = await postLogin(ctx, { password: 'not-the-right-password' });
      const unknownUser = await postLogin(ctx, { username: 'nobody' });

      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownUser.statusCode).toBe(401);
      expect(wrongPassword.body).toBe(unknownUser.body);
      expect(wrongPassword.body).toBe('{"error":"Unauthorized"}');

      // Byte-identical headers too, bar the ones that legitimately vary, and no
      // cookie on either.
      expect(stableHeaders(unknownUser.headers)).toEqual(stableHeaders(wrongPassword.headers));
      expect(ctx.cookieFrom(wrongPassword)).toBeNull();
      expect(ctx.cookieFrom(unknownUser)).toBeNull();
    });

    it('provably runs the dummy hash for an unknown username', async () => {
      ctx = await createAuthTestServer();
      const users = ctx.app.auth.users;

      const before = users.dummyVerifications;
      await postLogin(ctx, { username: 'nobody' });
      expect(users.dummyVerifications, 'unknown username took the dummy path').toBe(before + 1);

      // And does *not* take it for a known username with a wrong password: that
      // path already pays for a real argon2 verification.
      await postLogin(ctx, { password: 'wrong-but-long-enough' });
      expect(users.dummyVerifications).toBe(before + 1);
    });

    it('compares the username without short-circuiting on the first byte', async () => {
      ctx = await createAuthTestServer();
      const users = ctx.app.auth.users;

      // A username that shares a prefix, and one that shares its length, must
      // both take the same path as a completely unrelated one.
      for (const username of ['admi', 'adminX', 'admiN', 'zzzzz', 'a']) {
        const before = users.dummyVerifications;
        const res = await postLogin(ctx, { username });
        expect(res.statusCode, username).toBe(401);
        expect(users.dummyVerifications, username).toBe(before + 1);
      }
    });
  });

  // ── The second factor is not optional ──────────────────────────────────────

  describe('two-factor is mandatory', () => {
    it('gives the password step a pre-session that cannot reach anything', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);

      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
      const login = await postLogin(ctx);
      expect(login.json()).toEqual({ stage: 'totp' });
      const pre = ctx.cookieFrom(login);
      expect(pre).not.toBeNull();
      // Not the full session cookie from earlier.
      expect(pre).not.toBe(account.cookie);

      // Everything that matters is closed to it.
      for (const [method, path] of [
        ['GET', '/api/sessions'],
        ['POST', '/api/sessions/revoke-others'],
        ['GET', '/api/secrets'],
        ['POST', '/api/auth/step-up'],
        ['POST', '/api/security/password'],
        ['POST', '/api/security/recovery-codes'],
        ['POST', '/api/security/2fa/disable'],
        ['POST', '/api/security/base-path/regenerate'],
        ['POST', '/api/secrets/reveal'],
      ] as const) {
        const res = await ctx.app.inject({
          method,
          url: ctx.url(path),
          cookies: { [SESSION_COOKIE]: pre! },
          payload: {},
        });
        expect(res.statusCode, `${method} ${path}`).toBe(401);
      }
    });

    it('never turns a password alone into a full session', async () => {
      ctx = await createAuthTestServer();
      await enrollAccount(ctx);

      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
      const login = await postLogin(ctx);
      const pre = ctx.cookieFrom(login)!;

      const row = getDb()
        .prepare('SELECT auth_level FROM sessions ORDER BY id DESC LIMIT 1')
        .get() as { auth_level: string };
      expect(row.auth_level).toBe('pre');

      // Repeating the password step does not promote anything either: the only
      // full session in the table is the one enrolment produced.
      await postLogin(ctx);
      expect(fullSessionCount()).toBe(1);
      expect(preSessionCount()).toBe(2);

      // Only the second factor promotes one.
      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
      const totp = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login/totp'),
        cookies: { [SESSION_COOKIE]: pre },
        payload: { code: totpCodeAt(await secretOf(ctx), ctx.clock.now()) },
      });
      expect(totp.statusCode).toBe(200);
      expect(fullSessionCount()).toBe(2);
    });

    it('rejects a wrong code and keeps the session at pre', async () => {
      ctx = await createAuthTestServer();
      await enrollAccount(ctx);
      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);

      const login = await postLogin(ctx);
      const pre = ctx.cookieFrom(login)!;

      const bad = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login/totp'),
        cookies: { [SESSION_COOKIE]: pre },
        payload: { code: '000000' },
      });
      expect(bad.statusCode).toBe(401);
      expect(bad.body).toBe('{"error":"Unauthorized"}');

      // Still pre, so still useless.
      const sessions = await ctx.app.inject({
        method: 'GET',
        url: ctx.url('/api/sessions'),
        cookies: { [SESSION_COOKIE]: pre },
      });
      expect(sessions.statusCode).toBe(401);
    });
  });

  // ── Replay and recovery codes over HTTP ────────────────────────────────────

  describe('replay protection end to end', () => {
    it('refuses a code that already logged someone in, inside the same window', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      const secret = account.secret;

      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
      const code = totpCodeAt(secret, ctx.clock.now());

      const first = await postLogin(ctx);
      const firstPre = ctx.cookieFrom(first)!;
      const ok = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login/totp'),
        cookies: { [SESSION_COOKIE]: firstPre },
        payload: { code },
      });
      expect(ok.statusCode).toBe(200);

      // Five seconds later the code is still inside its validity window.
      ctx.clock.advance(5_000);
      const second = await postLogin(ctx);
      const secondPre = ctx.cookieFrom(second)!;
      const replay = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login/totp'),
        cookies: { [SESSION_COOKIE]: secondPre },
        payload: { code },
      });
      expect(replay.statusCode).toBe(401);

      const failures = auditRows().filter((r) => r.event === AuditEvent.TotpFailure);
      expect(failures.at(-1)?.meta).toMatchObject({ reason: 'replayed_totp_code' });
    });
  });

  describe('recovery codes end to end', () => {
    it('logs in with a recovery code exactly once', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      const code = account.recoveryCodes[0]!;

      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
      const first = await postLogin(ctx);
      const usedOnce = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login/totp'),
        cookies: { [SESSION_COOKIE]: ctx.cookieFrom(first)! },
        payload: { code },
      });
      expect(usedOnce.statusCode).toBe(200);
      expect(usedOnce.json()).toMatchObject({
        stage: 'authenticated',
        usedRecoveryCode: true,
        recoveryCodesRemaining: 9,
      });

      const second = await postLogin(ctx);
      const usedTwice = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login/totp'),
        cookies: { [SESSION_COOKIE]: ctx.cookieFrom(second)! },
        payload: { code },
      });
      expect(usedTwice.statusCode).toBe(401);

      expect(auditEvents()).toContain(AuditEvent.RecoveryCodeUsed);
    });
  });

  // ── Progressive delay ──────────────────────────────────────────────────────

  describe('progressive delay', () => {
    it('does not delay the first three failures, then follows the schedule', async () => {
      ctx = await createAuthTestServer();
      await enrollAccount(ctx);
      ctx.sleep.reset();

      const targets: number[] = [];
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        ctx.sleep.reset();
        const res = await postLogin(ctx, { password: 'wrong-password-here' });
        expect(res.statusCode).toBe(401);
        targets.push(ctx.sleep.total());
      }

      expect(targets).toEqual([0, 0, 0, 500, 1_000, 2_000, 4_000, 8_000]);
      expect(failureCount()).toBe(8);
    });

    it('caps at thirty seconds however many failures accumulate', async () => {
      ctx = await createAuthTestServer();
      await enrollAccount(ctx);

      // Straight to a high counter, rather than a hundred argon2 verifications.
      setFailureCount(40);

      ctx.sleep.reset();
      const res = await postLogin(ctx, { password: 'wrong-password-here' });
      expect(res.statusCode).toBe(401);
      expect(ctx.sleep.total()).toBe(MAX_DELAY_MS);
      expect(ctx.sleep.total()).toBeLessThanOrEqual(30_000);
    });

    it('delays a successful attempt exactly as much as a failing one', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);

      // Three failures: the fourth attempt is priced at 500ms whatever it does.
      setFailureCount(3);

      ctx.sleep.reset();
      const failing = await postLogin(ctx, { password: 'wrong-password-here' });
      expect(failing.statusCode).toBe(401);
      const failingDelay = ctx.sleep.total();

      // Back to three, and try the same attempt with the right password.
      setFailureCount(3);
      ctx.sleep.reset();
      const succeeding = await postLogin(ctx);
      expect(succeeding.statusCode).toBe(200);
      const succeedingDelay = ctx.sleep.total();

      expect(failingDelay).toBe(500);
      expect(succeedingDelay).toBe(500);
      expect(succeedingDelay).toBe(failingDelay);

      // The second factor step is delayed too — the counter is not reset by the
      // password step alone.
      expect(failureCount()).toBe(3);
      // A step on, because enrolment already consumed the current one and replay
      // protection is doing its job.
      ctx.clock.advance(2 * TOTP_PERIOD_SECONDS * 1000);
      ctx.sleep.reset();
      const totp = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login/totp'),
        cookies: { [SESSION_COOKIE]: ctx.cookieFrom(succeeding)! },
        payload: { code: totpCodeAt(account.secret, ctx.clock.now()) },
      });
      expect(totp.statusCode).toBe(200);
      expect(ctx.sleep.total()).toBe(500);
    });

    it('records the delay tier in the audit log, and only when there is one', async () => {
      ctx = await createAuthTestServer();
      await enrollAccount(ctx);

      setFailureCount(0);
      await postLogin(ctx, { password: 'wrong-password-here' });
      expect(auditEvents()).not.toContain(AuditEvent.DelayApplied);

      setFailureCount(5);
      await postLogin(ctx, { password: 'wrong-password-here' });
      const applied = auditRows().filter((r) => r.event === AuditEvent.DelayApplied);
      expect(applied).toHaveLength(1);
      expect(applied[0]!.meta).toMatchObject({ failures: 5, targetMs: 2_000 });
    });
  });

  describe('the failure counter', () => {
    it('counts a wrong code exactly like a wrong password', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      setFailureCount(0);

      await postLogin(ctx, { password: 'wrong-password-here' });
      expect(failureCount()).toBe(1);

      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
      const login = await postLogin(ctx);
      expect(failureCount(), 'a correct password neither counts nor resets').toBe(1);

      await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login/totp'),
        cookies: { [SESSION_COOKIE]: ctx.cookieFrom(login)! },
        payload: { code: '000000' },
      });
      expect(failureCount(), 'a wrong code counts').toBe(2);

      // Only both factors together clear it.
      const { response } = await loginFully(ctx, account.secret);
      expect(response.statusCode).toBe(200);
      expect(failureCount()).toBe(0);
    });

    it('is not reset by a correct password followed by a wrong code', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      setFailureCount(2);

      ctx.clock.advance(TOTP_PERIOD_SECONDS * 1000);
      const login = await postLogin(ctx);
      const pre = ctx.cookieFrom(login)!;

      const bad = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login/totp'),
        cookies: { [SESSION_COOKIE]: pre },
        payload: { code: '000000' },
      });
      expect(bad.statusCode).toBe(401);
      expect(failureCount()).toBe(3);

      void account;
    });

    it('survives a restart against the same volume', async () => {
      const first = await createAuthTestServer({}, { keepDataDir: true });
      const dataDir = first.dataDir;
      await enrollAccount(first);
      for (let i = 0; i < 3; i += 1) {
        await postLogin(first, { password: 'wrong-password-here' });
      }
      expect(failureCount()).toBe(3);
      await first.cleanup();

      ctx = await createAuthTestServer({}, { dataDir });
      expect(failureCount()).toBe(3);

      // And the next attempt is priced from the restored counter.
      ctx.sleep.reset();
      await postLogin(ctx, { password: 'wrong-password-here' });
      expect(ctx.sleep.total()).toBe(500);
    });
  });

  // ── Single flight ──────────────────────────────────────────────────────────

  describe('single-flight', () => {
    it('does not let N parallel attempts share one delay period', async () => {
      // Queue depth raised so both attempts are admitted rather than one 429ing;
      // the 429 behaviour at the default depth is asserted separately below.
      ctx = await createAuthTestServer({}, { authQueueLimit: 8 });
      await enrollAccount(ctx);
      setFailureCount(5); // every attempt is priced at 2s

      ctx.sleep.reset();
      const N = 4;
      const results = await Promise.all(
        Array.from({ length: N }, () => postLogin(ctx, { password: 'wrong-password-here' })),
      );

      for (const res of results) expect(res.statusCode).toBe(401);

      // Each attempt paid its own delay. Not one shared period.
      expect(ctx.sleep.calls).toHaveLength(N);
      expect(ctx.sleep.total()).toBeGreaterThanOrEqual(N * 2_000);
      // And the counter went up once per attempt, so none of them raced past it.
      expect(failureCount()).toBe(5 + N);
    });

    it('rejects a third concurrent attempt with 429 at the default queue depth', async () => {
      ctx = await createAuthTestServer();
      await enrollAccount(ctx);
      setFailureCount(6); // 4s each, so the first two are still in flight

      const attempts = Array.from({ length: 5 }, () =>
        postLogin(ctx, { password: 'wrong-password-here' }),
      );
      const results = await Promise.all(attempts);
      const codes = results.map((r) => r.statusCode).sort();

      // One running plus one queued are admitted; the rest are turned away.
      expect(codes).toEqual([401, 401, 429, 429, 429]);
      expect(results.find((r) => r.statusCode === 429)!.body).toBe(
        '{"error":"Too Many Requests"}',
      );
      // A rejection at the gate is not a failed credential check.
      expect(failureCount()).toBe(8);
    });
  });

  // ── Origin checking ────────────────────────────────────────────────────────

  describe('origin validation', () => {
    it('rejects a mutating request from another origin', async () => {
      ctx = await createAuthTestServer();

      const res = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login'),
        headers: { origin: 'https://evil.example' },
        payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('{"error":"Forbidden"}');
    });

    it('accepts a matching origin, and a request with none at all', async () => {
      ctx = await createAuthTestServer();

      const matching = await ctx.app.inject({
        method: 'POST',
        url: ctx.url('/api/auth/login'),
        headers: { origin: 'http://localhost:80', host: 'localhost:80' },
        payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
      });
      expect(matching.statusCode).toBe(200);

      // No Origin header: a non-browser client, which cannot be CSRF'd.
      const none = await postLogin(ctx);
      expect(none.statusCode).toBe(200);
    });
  });

  // ── Nothing at rest is plaintext ───────────────────────────────────────────

  describe('nothing sensitive at rest', () => {
    it('never stores a plaintext session token', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      const second = await loginFully(ctx, account.secret);

      const rows = getDb().prepare('SELECT token_hash FROM sessions').all() as {
        token_hash: string;
      }[];
      expect(rows.length).toBeGreaterThan(0);

      for (const row of rows) {
        // A sha256 hex digest, and nothing that resembles a cookie value.
        expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
        for (const token of [account.cookie, second.cookie]) {
          expect(row.token_hash).not.toContain(token);
        }
      }

      // Belt: no column of the sessions table holds either token.
      const dump = JSON.stringify(getDb().prepare('SELECT * FROM sessions').all());
      expect(dump).not.toContain(account.cookie);
      expect(dump).not.toContain(second.cookie);
    });

    it('never stores a plaintext TOTP secret', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);

      const dump = JSON.stringify(getDb().prepare('SELECT * FROM users').all());
      expect(dump).not.toContain(account.secret);
      const row = getDb()
        .prepare('SELECT totp_secret_encrypted FROM users WHERE id = ?')
        .get(SINGLE_USER_ID) as { totp_secret_encrypted: string };
      expect(row.totp_secret_encrypted.startsWith('v1.')).toBe(true);
    });

    it('never stores a plaintext recovery code', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);

      const dump = JSON.stringify(getDb().prepare('SELECT * FROM recovery_codes').all());
      for (const code of account.recoveryCodes) {
        expect(dump).not.toContain(code);
        expect(dump).not.toContain(code.replace('-', ''));
      }
    });

    it('keeps every credential out of the audit log', async () => {
      ctx = await createAuthTestServer();
      const account = await enrollAccount(ctx);
      await postLogin(ctx, { password: 'wrong-password-here' });
      await loginFully(ctx, account.secret);

      const dump = JSON.stringify(auditRows());
      expect(dump.length).toBeGreaterThan(0);
      for (const sensitive of [
        TEST_PASSWORD,
        'wrong-password-here',
        account.secret,
        account.cookie,
        ...account.recoveryCodes,
      ]) {
        expect(dump, sensitive.slice(0, 8)).not.toContain(sensitive);
      }
      // Not even the username, on a failure row.
      const failures = auditRows().filter((r) => r.event === AuditEvent.LoginFailure);
      expect(failures.length).toBeGreaterThan(0);
      for (const row of failures) {
        expect(Object.keys(row.meta)).toEqual(['reason', 'consecutiveFailures']);
      }
    });
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

const VOLATILE_HEADERS = ['date', 'content-length', 'connection'] as const;

function stableHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...headers };
  for (const name of VOLATILE_HEADERS) delete copy[name];
  return copy;
}

function passwordHash(): string {
  const row = getDb()
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(SINGLE_USER_ID) as { password_hash: string };
  return row.password_hash;
}

function failureCount(): number {
  const row = getDb()
    .prepare('SELECT consecutive_failures AS c FROM auth_failures WHERE id = 1')
    .get() as { c: number };
  return row.c;
}

/** Sets the counter directly, so a test can reach a high tier without 40 logins. */
function setFailureCount(value: number): void {
  getDb().prepare('UPDATE auth_failures SET consecutive_failures = ? WHERE id = 1').run(value);
}

function sessionCountAt(level: 'pre' | 'full'): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM sessions WHERE auth_level = ?')
    .get(level) as { c: number };
  return row.c;
}

const fullSessionCount = (): number => sessionCountAt('full');
const preSessionCount = (): number => sessionCountAt('pre');

interface AuditRow {
  event: string;
  outcome: string;
  meta: Record<string, unknown>;
}

function auditRows(): AuditRow[] {
  return (
    getDb().prepare('SELECT event, outcome, meta_json FROM audit_log ORDER BY id').all() as {
      event: string;
      outcome: string;
      meta_json: string;
    }[]
  ).map((row) => ({
    event: row.event,
    outcome: row.outcome,
    meta: JSON.parse(row.meta_json) as Record<string, unknown>,
  }));
}

function auditEvents(): string[] {
  return auditRows().map((row) => row.event);
}

/** The enrolled secret, decrypted out of the database for a test that needs it. */
async function secretOf(ctx: AuthTestContext): Promise<string> {
  const { decrypt, columnAad } = await import('../../src/server/crypto.js');
  const row = getDb()
    .prepare('SELECT totp_secret_encrypted FROM users WHERE id = ?')
    .get(SINGLE_USER_ID) as { totp_secret_encrypted: string };
  void ctx;
  return decrypt(row.totp_secret_encrypted, columnAad('users', SINGLE_USER_ID, 'totp_secret'));
}
