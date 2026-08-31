import { describe, it, expect, afterEach } from 'vitest';
import { generateSync } from 'otplib';
import { ScureBase32Plugin } from '@otplib/plugin-base32-scure';
import { getDb } from '../../src/server/db.js';
import { decrypt, columnAad } from '../../src/server/crypto.js';
import {
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_DRIFT_STEPS,
  TOTP_PERIOD_SECONDS,
  TOTP_SECRET_BYTES,
  TotpService,
} from '../../src/server/services/totp.service.js';
import { SINGLE_USER_ID, UserService } from '../../src/server/services/user.service.js';
import { createTestServer, type TestContext } from '../helpers/test-server.js';
import { FakeClock } from '../helpers/fake-clock.js';

const base32 = new ScureBase32Plugin();

/**
 * RFC 6238 Appendix B, the SHA-1 rows.
 *
 * The published values are eight digits; a six-digit code is the low six of the
 * same dynamically-truncated number, so the expectation is the last six
 * characters. These are the vectors that catch a wrong algorithm, a wrong period,
 * or a wrong truncation — a round-trip against our own generator would agree with
 * itself no matter what any of those were set to.
 */
const RFC6238_SEED = base32.encode(new TextEncoder().encode('12345678901234567890'), {
  padding: false,
});

const RFC6238_VECTORS: { epochSeconds: number; eightDigits: string }[] = [
  { epochSeconds: 59, eightDigits: '94287082' },
  { epochSeconds: 1_111_111_109, eightDigits: '07081804' },
  { epochSeconds: 1_111_111_111, eightDigits: '14050471' },
  { epochSeconds: 1_234_567_890, eightDigits: '89005924' },
  { epochSeconds: 2_000_000_000, eightDigits: '69279037' },
  { epochSeconds: 20_000_000_000, eightDigits: '65353130' },
];

describe('M1.4 — TOTP', () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  describe('parameters', () => {
    it('is RFC 6238 with the values every authenticator app assumes', () => {
      expect(TOTP_ALGORITHM).toBe('sha1');
      expect(TOTP_DIGITS).toBe(6);
      expect(TOTP_PERIOD_SECONDS).toBe(30);
      expect(TOTP_DRIFT_STEPS).toBe(1);
      // 160 bits, RFC 4226's recommendation for HMAC-SHA1.
      expect(TOTP_SECRET_BYTES).toBe(20);
    });

    it('matches the RFC 6238 SHA-1 reference vectors', () => {
      for (const { epochSeconds, eightDigits } of RFC6238_VECTORS) {
        const code = generateSync({
          secret: RFC6238_SEED,
          algorithm: TOTP_ALGORITHM,
          digits: TOTP_DIGITS,
          period: TOTP_PERIOD_SECONDS,
          epoch: epochSeconds,
        });
        expect(code, `t=${epochSeconds}`).toBe(eightDigits.slice(-TOTP_DIGITS));
      }
    });
  });

  describe('enrolment', () => {
    it('stores the secret encrypted under users:<id>:totp_secret and never in plaintext', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const clock = new FakeClock();
      const totp = new TotpService({ db: getDb(), clock });

      const { secret } = totp.beginEnrollment('admin');
      const plaintext = secret.reveal();

      const row = getDb()
        .prepare('SELECT totp_secret_encrypted FROM users WHERE id = ?')
        .get(SINGLE_USER_ID) as { totp_secret_encrypted: string };

      expect(row.totp_secret_encrypted).not.toContain(plaintext);
      expect(row.totp_secret_encrypted.startsWith('v1.')).toBe(true);

      // The AAD is exactly the one the brief specifies.
      expect(decrypt(row.totp_secret_encrypted, columnAad('users', SINGLE_USER_ID, 'totp_secret')))
        .toBe(plaintext);
      expect(columnAad('users', SINGLE_USER_ID, 'totp_secret')).toBe('users:1:totp_secret');
    });

    it('produces an otpauth URI carrying the secret and the issuer', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const totp = new TotpService({ db: getDb(), clock: new FakeClock() });

      const { secret, uri } = totp.beginEnrollment('admin');
      const raw = uri.reveal();

      expect(raw.startsWith('otpauth://totp/')).toBe(true);
      expect(raw).toContain(`secret=${secret.reveal()}`);
      expect(raw).toContain('issuer=cc-panel');
      // SecretString protects both: neither may leak through interpolation.
      expect(`${uri}`).toBe('[redacted]');
      expect(`${secret}`).toBe('[redacted]');
    });

    it('leaves two-factor disabled until a code confirms the secret', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const clock = new FakeClock();
      const totp = new TotpService({ db: getDb(), clock });

      const { secret } = totp.beginEnrollment('admin');
      expect(totp.hasSecret()).toBe(true);
      expect(totp.isEnabled()).toBe(false);

      // An unconfirmed secret cannot be used to authenticate.
      const code = generateSync({
        secret: secret.reveal(),
        algorithm: TOTP_ALGORITHM,
        digits: TOTP_DIGITS,
        period: TOTP_PERIOD_SECONDS,
        epoch: clock.epochSeconds(),
      });
      expect(totp.verify(code)).toEqual({ ok: false, reason: 'not-enrolled' });

      const confirmed = totp.completeEnrollment(code);
      expect(confirmed.ok).toBe(true);
      expect(totp.isEnabled()).toBe(true);
    });

    it('re-enrolling replaces the secret and clears the replay watermark', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const clock = new FakeClock();
      const totp = new TotpService({ db: getDb(), clock });

      const first = totp.beginEnrollment('admin');
      totp.completeEnrollment(codeFor(first.secret.reveal(), clock));
      expect(totp.lastAcceptedStep()).toBeGreaterThan(0);

      const second = totp.beginEnrollment('admin');
      expect(second.secret.reveal()).not.toBe(first.secret.reveal());
      expect(totp.lastAcceptedStep()).toBe(0);
      expect(totp.isEnabled()).toBe(false);

      // The old secret is gone, not merely superseded.
      clock.advance(TOTP_PERIOD_SECONDS * 1000);
      expect(totp.completeEnrollment(codeFor(first.secret.reveal(), clock)).ok).toBe(false);
      expect(totp.completeEnrollment(codeFor(second.secret.reveal(), clock)).ok).toBe(true);
    });
  });

  describe('drift window', () => {
    it('accepts one step early and one step late, and rejects two steps away', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });

      // A separate service per offset, because accepting a code moves the replay
      // watermark and would then reject the neighbouring steps for the right
      // reason but the wrong test.
      for (const offset of [-1, 0, 1]) {
        const clock = new FakeClock();
        const totp = freshEnrolled(clock);
        const code = codeFor(totp.secret, clock, offset);
        expect(totp.service.verify(code), `offset ${offset}`).toMatchObject({ ok: true });
      }

      for (const offset of [-2, 2, -3, 3]) {
        const clock = new FakeClock();
        const totp = freshEnrolled(clock);
        const code = codeFor(totp.secret, clock, offset);
        expect(totp.service.verify(code), `offset ${offset}`).toEqual({
          ok: false,
          reason: 'bad-code',
        });
      }
    });
  });

  describe('replay protection', () => {
    it('rejects a code that has already been accepted, inside its own window', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const clock = new FakeClock();
      const { service, secret } = freshEnrolled(clock);

      const code = codeFor(secret, clock);
      const first = service.verify(code);
      expect(first).toMatchObject({ ok: true });

      // Same code, same step, still inside its 30 seconds.
      clock.advance(5_000);
      expect(service.verify(code)).toEqual({ ok: false, reason: 'replayed' });

      // And still refused after the window would otherwise have moved on.
      clock.advance(TOTP_PERIOD_SECONDS * 1000);
      expect(service.verify(code)).toEqual({ ok: false, reason: 'replayed' });
    });

    it('requires a strictly greater step, so the accepted step is not reusable either', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const clock = new FakeClock();
      const { service, secret } = freshEnrolled(clock);

      // Accept a code from one step in the future (a phone running fast).
      const ahead = codeFor(secret, clock, 1);
      expect(service.verify(ahead)).toMatchObject({ ok: true });
      const watermark = service.lastAcceptedStep();

      // The *current* step is now at or below the watermark and must be refused,
      // even though it is a perfectly valid code for the current time.
      expect(service.verify(codeFor(secret, clock, 0))).toEqual({
        ok: false,
        reason: 'replayed',
      });

      // Moving on two steps clears it.
      clock.advance(2 * TOTP_PERIOD_SECONDS * 1000);
      expect(service.verify(codeFor(secret, clock))).toMatchObject({ ok: true });
      expect(service.lastAcceptedStep()).toBeGreaterThan(watermark);
    });

    it('persists the watermark, so a restart does not reopen a replay', async () => {
      const first = await createTestServer({ PANEL_BASE_PATH: 'x' }, { keepDataDir: true });
      const dataDir = first.dataDir;
      const clock = new FakeClock();
      const { service, secret } = freshEnrolled(clock);

      const code = codeFor(secret, clock);
      expect(service.verify(code)).toMatchObject({ ok: true });
      const watermark = service.lastAcceptedStep();
      await first.cleanup();

      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' }, { dataDir });
      const revived = new TotpService({ db: getDb(), clock });
      expect(revived.lastAcceptedStep()).toBe(watermark);
      expect(revived.verify(code)).toEqual({ ok: false, reason: 'replayed' });
    });
  });

  describe('malformed input', () => {
    it('treats a wrong-shaped code as a plain rejection rather than throwing', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const clock = new FakeClock();
      const { service } = freshEnrolled(clock);

      for (const bad of ['', '1', '12345', '1234567', 'abcdef', '  1234', '000000']) {
        expect(() => service.verify(bad)).not.toThrow();
        expect(service.verify(bad).ok, JSON.stringify(bad)).toBe(false);
      }
    });

    it('reports not-enrolled when there is no secret at all', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const totp = new TotpService({ db: getDb(), clock: new FakeClock() });
      expect(totp.hasSecret()).toBe(false);
      expect(totp.verify('123456')).toEqual({ ok: false, reason: 'not-enrolled' });
    });
  });

  describe('disable', () => {
    it('clears the secret, the flag, and the watermark', async () => {
      ctx = await createTestServer({ PANEL_BASE_PATH: 'x' });
      const clock = new FakeClock();
      const { service } = freshEnrolled(clock);

      service.disable();
      expect(service.isEnabled()).toBe(false);
      expect(service.hasSecret()).toBe(false);
      expect(service.lastAcceptedStep()).toBe(0);
    });
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function codeFor(secret: string, clock: FakeClock, stepOffset = 0): string {
  return generateSync({
    secret,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    epoch: clock.epochSeconds() + stepOffset * TOTP_PERIOD_SECONDS,
  });
}

/**
 * A service with two-factor enrolled and confirmed, and the replay watermark
 * pushed far enough back that the current step is still acceptable.
 */
function freshEnrolled(clock: FakeClock): { service: TotpService; secret: string } {
  const db = getDb();
  // The service needs a user row to hang the secret off.
  const users = new UserService({ db, clock });
  if (!users.exists()) {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, created_at, updated_at)
       VALUES (?, 'admin', 'not-a-real-hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(SINGLE_USER_ID);
  }

  const service = new TotpService({ db, clock });
  const { secret } = service.beginEnrollment('admin');
  const confirmed = service.completeEnrollment(codeFor(secret.reveal(), clock));
  if (!confirmed.ok) throw new Error('fixture failed to enrol');

  // Confirming consumed the current step, and that step becomes the replay
  // watermark. Move on *two* steps, so the whole ±1 drift window around the new
  // current step sits strictly above the watermark and the drift tests are
  // measuring drift rather than replay.
  clock.advance(2 * TOTP_PERIOD_SECONDS * 1000);
  return { service, secret: secret.reveal() };
}
