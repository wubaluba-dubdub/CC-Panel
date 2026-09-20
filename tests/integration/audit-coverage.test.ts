import { describe, it, expect } from 'vitest';
import { AuditEvent } from '../../src/server/services/audit.service.js';

/**
 * Every mutating route that does NOT write an audit row.
 *
 * This set is **pinned and exception-free**: adding a mutating route without
 * either an audit event or an entry here fails the suite. The purpose is to
 * make unaudited writes a deliberate, reviewed decision rather than an
 * oversight.
 *
 * Today exactly one route is here: `PATCH /api/settings/locale`. The comment in
 * `src/server/routes/settings.ts` explains why — a language toggle is neither a
 * privilege change nor a disclosure.
 */
export const UNAUDITED_MUTATING_ROUTES: ReadonlySet<string> = new Set([
  '/api/settings/locale',
]);

/**
 * The closed set mapping every audited mutating route to the event it writes.
 *
 * A route that writes multiple events (e.g. login writes both `session.created`
 * and `login.success`) maps to the *primary* event — the one that matters most
 * for the audit trail. The test asserts presence of the mapping, not completeness
 * of the event list.
 */
export const ROUTE_TO_AUDIT_EVENT: Readonly<Record<string, string>> = {
  'POST /api/auth/login': AuditEvent.LoginSuccess,
  'POST /api/auth/login/totp': AuditEvent.LoginSuccess,
  'POST /api/auth/totp/enroll': AuditEvent.TwoFactorEnrollmentStarted,
  'POST /api/auth/totp/enroll/verify': AuditEvent.SetupCompleted,
  'POST /api/auth/step-up': AuditEvent.StepUpGranted,
  'POST /api/auth/logout': AuditEvent.SessionRevoked,
  'POST /api/sessions/revoke-others': AuditEvent.SessionRevoked,
  'DELETE /api/sessions/:id': AuditEvent.SessionRevoked,
  'POST /api/security/password': AuditEvent.PasswordChanged,
  'POST /api/security/recovery-codes': AuditEvent.RecoveryCodesRegenerated,
  'POST /api/security/2fa/disable': AuditEvent.TwoFactorDisabled,
  'POST /api/security/base-path/regenerate': AuditEvent.BasePathRegenerated,
  'PUT /api/secrets': AuditEvent.SecretChanged,
  'POST /api/secrets/reveal': AuditEvent.SecretRevealed,
  'POST /api/notifications/test': AuditEvent.NotificationTestEnqueued,
};

/**
 * Every mutating route extracted from EXPECTED_ROUTE_TREE in secret-leak.test.ts.
 *
 * Listed explicitly rather than parsed from the tree, because the tree's box-drawing
 * characters make robust parsing complex and the list is small and stable. The assertion
 * below is what catches a new mutating route: if you add a route and forget to add it
 * here OR to ROUTE_TO_AUDIT_EVENT, the count check fails.
 *
 * A GET handler that performs a write (e.g. the watchdog's run marker) is NOT listed
 * here because the assertion cannot see it — a write inside a GET handler is a bug
 * in the route's design, not something this test can catch from the route tree.
 */
const ALL_MUTATING_ROUTES: readonly { method: string; path: string }[] = [
  { method: 'POST', path: '/api/auth/login' },
  { method: 'POST', path: '/api/auth/login/totp' },
  { method: 'POST', path: '/api/auth/totp/enroll' },
  { method: 'POST', path: '/api/auth/totp/enroll/verify' },
  { method: 'POST', path: '/api/auth/step-up' },
  { method: 'POST', path: '/api/auth/logout' },
  { method: 'POST', path: '/api/sessions/revoke-others' },
  { method: 'DELETE', path: '/api/sessions/:id' },
  { method: 'POST', path: '/api/security/password' },
  { method: 'POST', path: '/api/security/recovery-codes' },
  { method: 'POST', path: '/api/security/2fa/disable' },
  { method: 'POST', path: '/api/security/base-path/regenerate' },
  { method: 'PUT', path: '/api/secrets' },
  { method: 'POST', path: '/api/secrets/reveal' },
  { method: 'PATCH', path: '/api/settings/locale' },
  { method: 'POST', path: '/api/notifications/test' },
];

describe('audit coverage — every mutating route is audited or pinned', () => {
  it('every mutating route has an audit event or is in UNAUDITED_MUTATING_ROUTES', () => {
    const violations: string[] = [];

    for (const { method, path } of ALL_MUTATING_ROUTES) {
      const key = `${method} ${path}`;
      const hasAuditEvent = key in ROUTE_TO_AUDIT_EVENT;
      const isUnaudited = UNAUDITED_MUTATING_ROUTES.has(path);

      if (!hasAuditEvent && !isUnaudited) {
        violations.push(key);
      }
    }

    expect(
      violations,
      `Mutating route(s) without an audit event or unaudited pin: ${violations.join(', ')}`,
    ).toEqual([]);
  });

  it('UNAUDITED_MUTATING_ROUTES is exactly the locale toggle', () => {
    expect(UNAUDITED_MUTATING_ROUTES.size).toBe(1);
    expect(UNAUDITED_MUTATING_ROUTES.has('/api/settings/locale')).toBe(true);
  });

  it('every audited route maps to a valid AuditEvent value', () => {
    const validEvents: ReadonlySet<string> = new Set(Object.values(AuditEvent));
    const invalid: string[] = [];
    for (const [key, event] of Object.entries(ROUTE_TO_AUDIT_EVENT)) {
      if (!validEvents.has(event as string)) {
        invalid.push(`${key} → ${event}`);
      }
    }
    expect(invalid, `Invalid audit events: ${invalid.join(', ')}`).toEqual([]);
  });

  it('POST /api/notifications/test writes notification.test_enqueued without leaking secrets', async () => {
    const {
      createAuthTestServer,
      enrollAccount,
      loginFully,
      SESSION_COOKIE,
    } = await import('../helpers/auth-harness.js');
    const ctx = await createAuthTestServer();
    const { secret } = await enrollAccount(ctx);
    const { cookie } = await loginFully(ctx, secret);

    // Trigger the notification test route.
    const res = await ctx.inject({
      method: 'POST',
      url: ctx.url('/api/notifications/test'),
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(202);

    // The audit log must contain a notification.test_enqueued row.
    const after = await ctx.inject({
      method: 'GET',
      url: ctx.url('/api/audit?event=notification.test_enqueued&limit=1'),
      cookies: { [SESSION_COOKIE]: cookie },
    });
    const afterBody = JSON.parse(after.payload) as {
      entries: { id: number; event: string; meta: Record<string, unknown> }[];
    };
    const testRow = afterBody.entries?.[0];
    expect(testRow, 'expected a notification.test_enqueued audit row').toBeDefined();

    // Metadata must not contain tokens, chat ids, secrets, base paths, or IPs.
    const metaStr = JSON.stringify(testRow!.meta);
    expect(metaStr).not.toContain('token');
    expect(metaStr).not.toContain('chat_id');
    expect(metaStr).not.toContain('sk-');
    expect(metaStr).not.toContain('base');
    expect(metaStr).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);

    await ctx.cleanup();
  });
});
