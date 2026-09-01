import type { FastifyInstance } from 'fastify';
import { AuditEvent } from '../services/audit.service.js';
import type { AuthRuntime } from '../services/auth-runtime.js';
import { HttpError, requireStepUp } from '../plugins/auth.js';
import { regenerateBasePath } from '../services/instance.service.js';
import { clientIpForDisplay, userAgentForDisplay } from '../utils/client-ip.js';
import { changePasswordBody, parseBody, secretRefBody, secretSetBody } from '../utils/zod-schemas.js';
import { WeakPasswordError } from '../utils/weak-passwords.js';
import type {
  BasePathRegeneratedResponse,
  PasswordChangedResponse,
  RecoveryCodesResponse,
  SecretMetadataResponse,
  SecretRevealResponse,
} from '../../shared/types.js';

/**
 * The privileged operations.
 *
 * Every route here is behind {@link requireStepUp}: a full session is not enough,
 * the client must have re-entered the password *and* a fresh second-factor code
 * within the last five minutes. That is what makes a stolen session cookie a
 * bounded loss — it can read the panel, but it cannot change the password, cannot
 * read a stored credential, and cannot turn the second factor off.
 */
export default async function securityRoutes(
  app: FastifyInstance,
  opts: { runtime: AuthRuntime },
): Promise<void> {
  const { runtime } = opts;
  const stepUp = { preHandler: requireStepUp(runtime) };

  const who = (
    req: Parameters<typeof clientIpForDisplay>[0],
  ): { actorIp: string | null; userAgent: string | null } => ({
    actorIp: clientIpForDisplay(req),
    userAgent: userAgentForDisplay(req),
  });

  // ── Password change ────────────────────────────────────────────────────────
  //
  // The current password is not asked for again: the step-up that got here
  // already required it, less than five minutes ago, together with a code.
  app.post('/api/security/password', stepUp, async (req, reply) => {
    const { newPassword } = parseBody(changePasswordBody, req.body);
    const session = req.session!;

    try {
      await runtime.users.setPassword(newPassword);
    } catch (err) {
      if (err instanceof WeakPasswordError) throw new HttpError(400, err.message);
      throw err;
    }

    // A privilege change: rotate. The step-up is spent at the same time, so the
    // new password cannot be immediately followed by another privileged action on
    // the strength of the old step-up.
    const { token, session: rotated } = runtime.sessions.rotate(session.id);
    runtime.sessions.clearStepUp(session.id);
    runtime.cookies.setSession(reply, token, rotated);

    // Every other session dies, immediately.
    //
    // The only reason to change a password is fear that it leaked, and rotating
    // just this one leaves whoever the operator is afraid of holding a live session
    // that the new password does nothing about. Server-side sessions are the whole
    // point: revocation takes effect on the very next request, with no window.
    // The operator's own device is the one that keeps working — it is the one that
    // just proved both factors and stepped up.
    const revoked = runtime.sessions.revokeOthers(rotated.id);

    runtime.audit.write({
      event: AuditEvent.PasswordChanged,
      outcome: 'success',
      ...who(req),
      meta: { sessionId: session.id, revokedSessions: revoked },
    });

    if (revoked > 0) {
      runtime.audit.write({
        event: AuditEvent.SessionRevoked,
        outcome: 'success',
        ...who(req),
        meta: { keptSessionId: rotated.id, revoked, reason: 'password_changed' },
      });
    }

    const response: PasswordChangedResponse = { ok: true, revokedSessions: revoked };
    return response;
  });

  // ── Recovery codes ─────────────────────────────────────────────────────────
  app.post('/api/security/recovery-codes', stepUp, async (req) => {
    const session = req.session!;
    const codes = await runtime.recovery.regenerate();

    runtime.audit.write({
      event: AuditEvent.RecoveryCodesRegenerated,
      outcome: 'success',
      ...who(req),
      meta: { sessionId: session.id, count: codes.length },
    });

    // Shown exactly once. Only the argon2 hashes remain after this response.
    const response: RecoveryCodesResponse = {
      recoveryCodes: codes.map((code) => code.reveal()),
    };
    return response;
  });

  // ── Two-factor off ─────────────────────────────────────────────────────────
  //
  // Recovery codes go with it: they are second-factor material, and leaving them
  // live would mean "two-factor disabled" still had a second factor lying around.
  app.post('/api/security/2fa/disable', stepUp, async (req, reply) => {
    const session = req.session!;

    if (!runtime.totp.isEnabled()) throw new HttpError(409, 'two-factor is not enabled');

    runtime.totp.disable();
    runtime.recovery.clear();

    runtime.audit.write({
      event: AuditEvent.TwoFactorDisabled,
      outcome: 'success',
      ...who(req),
      meta: { sessionId: session.id },
    });

    return reply.code(204).send();
  });

  // ── Base path regeneration ─────────────────────────────────────────────────
  app.post('/api/security/base-path/regenerate', stepUp, async (req) => {
    const session = req.session!;

    // With PANEL_BASE_PATH set, the environment wins on every boot and a
    // regenerated instance.json would be silently ignored. Say so rather than
    // pretending to have done something.
    if (runtime.env.PANEL_BASE_PATH !== undefined) {
      throw new HttpError(
        409,
        'PANEL_BASE_PATH is set in the environment and takes precedence; change it there',
      );
    }

    const next = regenerateBasePath(runtime.env.PANEL_DATA_DIR);

    // The new value is not put in the audit meta: the audit log is readable from
    // inside the panel and there is no reason for the prefix to be in it twice
    // over. AuditService would elide the *old* one anyway.
    runtime.audit.write({
      event: AuditEvent.BasePathRegenerated,
      outcome: 'success',
      ...who(req),
      meta: { sessionId: session.id },
    });

    const response: BasePathRegeneratedResponse = { basePath: next, restartRequired: true };
    return response;
  });

  // ── Stored secrets ─────────────────────────────────────────────────────────
  //
  // The listing is metadata only and needs a full session; revealing or writing a
  // value is step-up gated. The settings UI that drives these lands in M1.5 — they
  // are here now because the step-up requirement is only real if the routes it
  // guards exist.
  app.get('/api/secrets', async (req) => {
    if (req.session === null || req.session.authLevel !== 'full') {
      throw new HttpError(401, 'authentication required');
    }
    const response: SecretMetadataResponse = { secrets: runtime.secrets.list() };
    return response;
  });

  app.post('/api/secrets/reveal', stepUp, async (req) => {
    const { scope, name } = parseBody(secretRefBody, req.body);
    const session = req.session!;

    const secret = runtime.secrets.get(scope, name);
    if (secret === null) throw new HttpError(404, 'no such secret');

    runtime.audit.write({
      event: AuditEvent.SecretRevealed,
      outcome: 'success',
      ...who(req),
      // The scope and name, never the value, and never the masked value either —
      // a mask in an append-only log accumulates into a partial disclosure.
      meta: { sessionId: session.id, scope, name },
    });

    const response: SecretRevealResponse = { scope, name, value: secret.reveal() };
    return response;
  });

  app.put('/api/secrets', stepUp, async (req, reply) => {
    const { scope, name, value } = parseBody(secretSetBody, req.body);
    const session = req.session!;

    const existed = runtime.secrets.has(scope, name);
    runtime.secrets.set(scope, name, value);

    runtime.audit.write({
      event: AuditEvent.SecretChanged,
      outcome: 'success',
      ...who(req),
      meta: { sessionId: session.id, scope, name, replaced: existed },
    });

    return reply.code(204).send();
  });
}
