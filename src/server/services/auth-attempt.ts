import type { FastifyRequest } from 'fastify';
import { AuditEvent } from './audit.service.js';
import { targetForAttempt } from './auth-delay.service.js';
import type { AuthRuntime } from './auth-runtime.js';
import { clientIpForDisplay, userAgentForDisplay } from '../utils/client-ip.js';

/**
 * Runs one authentication attempt under the single-flight gate and the
 * progressive delay.
 *
 * Every endpoint that checks a credential — the password step, the second-factor
 * step, enrolment confirmation, step-up — goes through here. Two properties come
 * out of that:
 *
 * **The delay applies to successes as well as failures.** The target is priced
 * from the counter as it stands when the attempt starts, as though the attempt
 * were about to fail. A failure lands on that target; a success resets the counter
 * and lands on the same target. If only failures were delayed, a correct password
 * would be the one attempt that came back fast, and the delay would have handed
 * the attacker a cleaner oracle than the one it was meant to close.
 *
 * **Attempts do not overlap.** Without the gate, a thousand parallel requests all
 * serve the same delay simultaneously and a thousand guesses cost one delay
 * period. With it, they cost a thousand.
 *
 * ### Where the clock starts
 *
 * From the moment the attempt acquires the gate, not from when the socket was
 * accepted. This is a deliberate departure from "measure from request receipt",
 * and the two requirements are in direct conflict: if a queued attempt's target
 * were measured from its arrival, the time it spent waiting for the gate would
 * count towards its own target, it would need no padding of its own, and N
 * parallel attempts would again cost one delay period — the exact failure the
 * gate exists to prevent.
 *
 * What "measure from receipt" is actually for is preserved: the target is a total
 * time for the attempt including argon2, not argon2 plus a sleep, so argon2's
 * timing variance is absorbed into the target rather than added on top of it.
 */
export async function runAuthAttempt<T>(
  runtime: AuthRuntime,
  req: FastifyRequest,
  attempt: () => Promise<T>,
): Promise<T> {
  return runtime.gate.run(async () => {
    const startedAt = runtime.clock.now();
    const failuresOnArrival = runtime.delay.failureCount();
    const targetMs = targetForAttempt(failuresOnArrival);

    try {
      return await attempt();
    } finally {
      const paddedMs = await runtime.delay.pad(startedAt, targetMs);
      if (targetMs > 0) {
        runtime.audit.write({
          event: AuditEvent.DelayApplied,
          outcome: 'success',
          actorIp: clientIpForDisplay(req),
          userAgent: userAgentForDisplay(req),
          meta: { failures: failuresOnArrival, targetMs, paddedMs },
        });
      }
    }
  });
}
