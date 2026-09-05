import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuditEvent, FailureReason, type FailureReasonName } from '../services/audit.service.js';
import { runAuthAttempt } from '../services/auth-attempt.js';
import type { AuthRuntime } from '../services/auth-runtime.js';
import {
  HttpError,
  requireFullSession,
  requireLevel,
} from '../plugins/auth.js';
import { clientIpForDisplay, userAgentForDisplay } from '../utils/client-ip.js';
import { codeBody, loginBody, parseBody, stepUpBody } from '../utils/zod-schemas.js';
import {
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
} from '../services/totp.service.js';
import type {
  EnrollmentResponse,
  EnrollmentVerifiedResponse,
  LoginResponse,
  MeResponse,
  SessionSummary,
  StepUpResponse,
  TotpStepResponse,
} from '../../shared/types.js';

/** A six-digit string is a TOTP code; anything else is treated as a recovery code. */
const TOTP_CODE_SHAPE = /^\d{6}$/;

export function toSessionSummary(
  session: { id: number; authLevel: 'pre' | 'full'; createdAt: string; lastSeenAt: string; expiresAt: string; absoluteExpiresAt: string | null; ip: string | null; userAgent: string | null },
  currentId: number,
): SessionSummary {
  return {
    id: session.id,
    authLevel: session.authLevel,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    ip: session.ip,
    userAgent: session.userAgent,
    current: session.id === currentId,
  };
}

function unreachable(message: string): never {
  throw new HttpError(500, message);
}

export default async function authRoutes(
  app: FastifyInstance,
  opts: { runtime: AuthRuntime },
): Promise<void> {
  const { runtime } = opts;

  /** Audit helper: the two display-only fields, from the request, every time. */
  const who = (req: FastifyRequest): { actorIp: string | null; userAgent: string | null } => ({
    actorIp: clientIpForDisplay(req),
    userAgent: userAgentForDisplay(req),
  });

  /**
   * Records a failed attempt: bump the counter, write the audit row.
   *
   * The counter is bumped for a wrong password and a wrong code alike. A correct
   * password followed by a wrong code therefore leaves the counter higher than it
   * started, and never resets it — the expensive half of a guess cannot be used to
   * clear the cheap half's accumulated cost.
   */
  const recordFailure = (
    req: FastifyRequest,
    event: typeof AuditEvent.LoginFailure | typeof AuditEvent.TotpFailure,
    reason: FailureReasonName,
  ): void => {
    const failures = runtime.delay.recordFailure();
    runtime.audit.write({
      event,
      outcome: 'failure',
      ...who(req),
      // The reason category only: never the attempted username, never the code.
      meta: { reason, consecutiveFailures: failures },
    });
  };

  // ── Stage 1: password ──────────────────────────────────────────────────────
  //
  // Succeeding here does not produce a usable session. It produces a five-minute
  // 'pre' session that can reach the second-factor and enrolment endpoints and
  // nothing else, which is what makes it safe to hand out a cookie between the two
  // steps of a login.
  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = parseBody(loginBody, req.body);

    return runAuthAttempt(runtime, req, async (): Promise<LoginResponse> => {
      const user = await runtime.users.verifyCredentials(username, password);

      if (user === null) {
        recordFailure(req, AuditEvent.LoginFailure, FailureReason.BadCredentials);
        // Byte-identical for an unknown username and a wrong password. The
        // dummy-hash path in verifyCredentials makes the timing identical too.
        throw new HttpError(401, 'invalid credentials');
      }

      const { token, session } = runtime.sessions.create({
        authLevel: 'pre',
        ip: clientIpForDisplay(req),
        userAgent: userAgentForDisplay(req),
      });
      runtime.cookies.setSession(reply, token, session);

      runtime.audit.write({
        event: AuditEvent.SessionCreated,
        outcome: 'success',
        ...who(req),
        meta: { sessionId: session.id, authLevel: 'pre' },
      });

      // Not a success yet, so the counter is untouched: it resets only when both
      // factors have been accepted.
      return { stage: runtime.totp.isEnabled() ? 'totp' : 'setup' };
    });
  });

  // ── Stage 2: second factor ─────────────────────────────────────────────────
  app.post(
    '/api/auth/login/totp',
    { preHandler: requireLevel('pre') },
    async (req, reply) => {
      const { code } = parseBody(codeBody, req.body);
      const session = req.session!;

      return runAuthAttempt(runtime, req, async (): Promise<TotpStepResponse> => {
        if (!runtime.totp.isEnabled()) {
          // Enrolment has not been completed, so there is no second factor to
          // check. Not a credential failure; not counted as one.
          runtime.audit.write({
            event: AuditEvent.LoginFailure,
            outcome: 'failure',
            ...who(req),
            meta: { reason: FailureReason.TwoFactorNotEnrolled },
          });
          throw new HttpError(409, 'two-factor enrolment is not complete');
        }

        const usedRecoveryCode = !TOTP_CODE_SHAPE.test(code);

        if (usedRecoveryCode) {
          const spent = await runtime.recovery.consume(code);
          if (!spent) {
            recordFailure(req, AuditEvent.TotpFailure, FailureReason.BadRecoveryCode);
            throw new HttpError(401, 'invalid credentials');
          }
          runtime.audit.write({
            event: AuditEvent.RecoveryCodeUsed,
            outcome: 'success',
            ...who(req),
            meta: { remaining: runtime.recovery.remaining() },
          });
        } else {
          const result = runtime.totp.verify(code);
          if (!result.ok) {
            recordFailure(
              req,
              AuditEvent.TotpFailure,
              result.reason === 'replayed'
                ? FailureReason.ReplayedTotpCode
                : FailureReason.BadTotpCode,
            );
            throw new HttpError(401, 'invalid credentials');
          }
        }

        // Privilege change: new token, same row. The 'pre' cookie value stops
        // working the instant this returns.
        const { token, session: promoted } = runtime.sessions.rotate(session.id, {
          toLevel: 'full',
        });
        runtime.cookies.setSession(reply, token, promoted);

        // Both factors accepted — and this is the only place the counter resets.
        runtime.delay.reset();

        runtime.audit.write({
          event: AuditEvent.LoginSuccess,
          outcome: 'success',
          ...who(req),
          meta: { sessionId: session.id, usedRecoveryCode },
        });

        return {
          stage: 'authenticated',
          ...(usedRecoveryCode ? { usedRecoveryCode: true } : {}),
          recoveryCodesRemaining: runtime.recovery.remaining(),
        };
      });
    },
  );

  // ── Enrolment ──────────────────────────────────────────────────────────────
  //
  // Reachable from a 'pre' session, which is what makes first-run setup possible:
  // there is no full session to be had until two-factor exists. Re-enrolling from
  // an already-enrolled account is a privileged change and needs a step-up.
  app.post('/api/auth/totp/enroll', { preHandler: requireLevel('pre', 'full') }, async (req) => {
    const session = req.session!;
    const user = runtime.users.find() ?? unreachable('no user');
    // Read before beginEnrollment(), which resets the flag to 0.
    const wasEnabled = runtime.totp.isEnabled();

    if (wasEnabled && !runtime.sessions.hasStepUp(session)) {
      throw new HttpError(403, 'step-up re-authentication required');
    }

    const enrollment = runtime.totp.beginEnrollment(user.username);

    // No secret and no URI in the audit meta — AuditService rejects a
    // SecretString outright, and this is the shape of call site that tempts one in.
    runtime.audit.write({
      event: AuditEvent.TwoFactorEnrollmentStarted,
      outcome: 'success',
      ...who(req),
      meta: { sessionId: session.id, reEnrollment: wasEnabled },
    });

    const response: EnrollmentResponse = {
      secret: enrollment.secret.reveal(),
      otpauthUri: enrollment.uri.reveal(),
      algorithm: TOTP_ALGORITHM,
      digits: TOTP_DIGITS,
      periodSeconds: TOTP_PERIOD_SECONDS,
    };
    return response;
  });

  app.post(
    '/api/auth/totp/enroll/verify',
    { preHandler: requireLevel('pre', 'full') },
    async (req, reply) => {
      const { code } = parseBody(codeBody, req.body);
      const session = req.session!;

      return runAuthAttempt(runtime, req, async (): Promise<EnrollmentVerifiedResponse> => {
        if (!runtime.totp.hasSecret()) {
          throw new HttpError(409, 'no enrolment in progress');
        }

        const result = runtime.totp.completeEnrollment(code);
        if (!result.ok) {
          recordFailure(req, AuditEvent.TotpFailure, FailureReason.BadTotpCode);
          throw new HttpError(401, 'invalid credentials');
        }

        // Shown exactly once. Only the argon2 hashes are kept.
        const codes = await runtime.recovery.regenerate();

        const { token, session: promoted } = runtime.sessions.rotate(session.id, {
          toLevel: 'full',
        });
        runtime.cookies.setSession(reply, token, promoted);

        // Password (stage 1, or the existing full session) plus second factor.
        runtime.delay.reset();

        runtime.audit.write({
          event: AuditEvent.SetupCompleted,
          outcome: 'success',
          ...who(req),
          meta: { sessionId: session.id, recoveryCodes: codes.length },
        });
        runtime.audit.write({
          event: AuditEvent.LoginSuccess,
          outcome: 'success',
          ...who(req),
          meta: { sessionId: session.id, viaEnrollment: true },
        });

        return {
          stage: 'authenticated',
          recoveryCodes: codes.map((secret) => secret.reveal()),
        };
      });
    },
  );

  // ── Step-up ────────────────────────────────────────────────────────────────
  app.post('/api/auth/step-up', { preHandler: requireFullSession }, async (req) => {
    const { password, code } = parseBody(stepUpBody, req.body);
    const session = req.session!;
    const user = runtime.users.find() ?? unreachable('no user');

    return runAuthAttempt(runtime, req, async (): Promise<StepUpResponse> => {
      const verified = await runtime.users.verifyCredentials(user.username, password);
      if (verified === null) {
        recordFailure(req, AuditEvent.LoginFailure, FailureReason.BadCredentials);
        throw new HttpError(401, 'invalid credentials');
      }

      const result = runtime.totp.verify(code);
      if (!result.ok) {
        recordFailure(
          req,
          AuditEvent.TotpFailure,
          result.reason === 'replayed'
            ? FailureReason.ReplayedTotpCode
            : FailureReason.BadTotpCode,
        );
        throw new HttpError(401, 'invalid credentials');
      }

      const stepUpUntil = runtime.sessions.grantStepUp(session.id);
      // Password and second factor both accepted.
      runtime.delay.reset();

      runtime.audit.write({
        event: AuditEvent.StepUpGranted,
        outcome: 'success',
        ...who(req),
        meta: { sessionId: session.id, until: stepUpUntil },
      });

      return { stepUpUntil };
    });
  });

  // ── Session introspection and logout ───────────────────────────────────────
  app.get('/api/auth/me', { preHandler: requireLevel('pre', 'full') }, async (req) => {
    const session = req.session!;
    const user = runtime.users.find() ?? unreachable('no user');

    const stage =
      session.authLevel === 'full' ? 'authenticated' : runtime.totp.isEnabled() ? 'totp' : 'setup';

    const response: MeResponse = {
      username: user.username,
      stage,
      totpEnabled: runtime.totp.isEnabled(),
      stepUpActive: runtime.sessions.hasStepUp(session),
      stepUpUntil: session.stepUpUntil,
      recoveryCodesRemaining: runtime.recovery.remaining(),
      // Null when the operator has never chosen, which is not the same as `'en'`: the
      // client keeps using the `Accept-Language` guess `bootstrap.js` gave it until there
      // is a stored answer to override it with.
      locale: user.locale,
      session: toSessionSummary(session, session.id),
    };
    return response;
  });

  app.post(
    '/api/auth/logout',
    { preHandler: requireLevel('pre', 'full') },
    async (req, reply: FastifyReply) => {
      const session = req.session!;
      runtime.sessions.revoke(session.id);
      runtime.cookies.clearSession(reply);

      runtime.audit.write({
        event: AuditEvent.SessionRevoked,
        outcome: 'success',
        ...who(req),
        meta: { sessionId: session.id, reason: 'logout' },
      });

      return reply.code(204).send();
    },
  );
}
