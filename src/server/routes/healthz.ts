import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { appliedMigrations, migrationFiles } from '../db.js';
import { HEALTHZ_PATH } from '../plugins/base-path.js';

/**
 * `GET /healthz` — the only route outside the secret base path, and the one Railway
 * decides deployments with.
 *
 * ## What it asserts, and why that is the line
 *
 * Railway polls the configured healthcheck path until it gets a 200 and **only then**
 * makes the new deployment live; it does not poll afterwards. That single fact settles
 * the design, because it makes the two failure directions completely asymmetric:
 *
 * - A `/healthz` that fails during boot costs a deployment. The previous deployment
 *   stays up, which is the *correct* outcome when the new one is broken — the cost is
 *   a red deploy, not an outage.
 * - A `/healthz` that answers 200 before the panel can actually serve pushes a broken
 *   deployment live, and nothing will notice again until a human does.
 *
 * So the probe leans toward the first: **reachability plus a bounded read of the
 * database.** Reachability alone would already be a decent answer here, because
 * `buildServer` opens the database and runs migrations *before* `listen()` — a
 * container that accepts a TCP connection has necessarily got that far. But "the
 * database opened once, minutes ago" is not "the database is readable now", and the
 * cases that separate them are exactly the ones a volume-backed deployment hits: the
 * mount detached, the disk filled, the file was replaced by a restore.
 *
 * The read is one prepared statement against `schema_migrations`, compared with the
 * number of migration files that shipped in this build. That answers a second question
 * for free — *are all migrations applied* — which matters because a partially migrated
 * database is the one shape that would otherwise serve happily until it touched the
 * missing table.
 *
 * ## What it deliberately does not do
 *
 * - **No write.** A write probe would catch a full disk, but at the price of WAL churn
 *   on every poll forever, and a health endpoint that mutates state is a bad trade.
 * - **No detail in the body.** Success is exactly `{"ok":true}`; failure is a `503`
 *   with exactly `{"ok":false}`. The reason goes to the log. This endpoint is
 *   unauthenticated and reachable by anyone who can reach the panel at all, and
 *   "migrations applied: 6 of 8, at /data/panel.db" is free reconnaissance.
 * - **No version, no uptime, no build id.** Asserted by
 *   `tests/integration/healthz.test.ts`.
 * - **No base path.** It could not include one meaningfully — it is mounted outside
 *   the prefix precisely so an unconfigured prober can reach it.
 *
 * It is exempt from `Host` validation (`plugins/origin-check.ts`: Docker's own
 * `HEALTHCHECK` arrives as `localhost:8080` while the public host is something else,
 * and a health probe that 403s is a container-kill primitive) and from the rate
 * limiter (`plugins/rate-limit.ts`: a 429'd probe is the same primitive). Both
 * exemptions predate this milestone; this comment is here so the next reader does not
 * have to rediscover that they are deliberate.
 */

export interface HealthVerdict {
  ok: boolean;
  /** Logged, never sent. */
  reason?: string;
}

export interface HealthProbeOptions {
  db: Database;
  /** How many migrations this build ships. Read once, at boot. */
  expectedMigrations: number;
}

/**
 * Builds the probe, preparing its statement once.
 *
 * Prepared at construction rather than per request: it runs on every poll for the life
 * of the container, and `prepare()` on every call would be the only expensive part of
 * an otherwise free check.
 */
export function createHealthProbe(opts: HealthProbeOptions): () => HealthVerdict {
  const { db, expectedMigrations } = opts;

  return function probe(): HealthVerdict {
    let applied: number[];
    try {
      applied = appliedMigrations(db);
    } catch (err) {
      return {
        ok: false,
        reason: `database unreadable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (applied.length < expectedMigrations) {
      return {
        ok: false,
        reason: `only ${applied.length} of ${expectedMigrations} migrations are applied`,
      };
    }

    return { ok: true };
  };
}

/** The number of migrations on disk in this build. Throws if the directory is missing. */
export function shippedMigrationCount(): number {
  return migrationFiles().length;
}

export interface HealthzOptions {
  probe: () => HealthVerdict;
}

export default async function healthzRoutes(
  app: FastifyInstance,
  opts: HealthzOptions,
): Promise<void> {
  const OK = JSON.stringify({ ok: true });
  const NOT_OK = JSON.stringify({ ok: false });

  app.get(HEALTHZ_PATH, async (req, reply) => {
    const verdict = opts.probe();

    // `no-store` because a shared cache between a prober and this endpoint could serve
    // a 200 that was true a minute ago. Railway's healthcheck has no such cache, and
    // neither does Docker's, but a response with no `Cache-Control`, no `ETag` and no
    // `Last-Modified` is heuristically cacheable, and "the health endpoint said fine"
    // is the last answer that should ever come out of a cache.
    reply.header('Cache-Control', 'no-store');

    if (!verdict.ok) {
      req.log.error({ health: verdict.reason }, 'health check failed');
      return reply.code(503).type('application/json; charset=utf-8').send(NOT_OK);
    }

    return reply.type('application/json; charset=utf-8').send(OK);
  });
}
