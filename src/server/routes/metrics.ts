import type { FastifyInstance } from 'fastify';
import { requireFullSession } from '../plugins/auth.js';
import type { ResourceSampler } from '../services/resources.service.js';
import type { Watchdog } from '../services/watchdog.service.js';
import type { MetricsResponse } from '../../shared/types.js';

/**
 * `GET /api/metrics` — memory, CPU and volume figures.
 *
 * **Full session, not step-up.** Reading a resource figure is not a state change, and
 * demanding a fresh code to look at a gauge pushes the operator toward not looking —
 * the same reasoning as the audit query API. A `pre` session cannot read it: it has
 * passed one factor.
 *
 * **Raw numbers and nulls only.** No percentages rendered as text, no units in words,
 * no `"200 MB / 1 GB"`. The server has no locale (R3), and a formatted quantity is a
 * translated string: `1.5 GB` is `۱٫۵ گیگابایت` for this operator, and the thousands
 * separator, the decimal mark and the digits are all different. The client formats.
 *
 * **The watchdog's status rides in this response rather than in a route of its own.**
 * Same session requirement, same poll, no new line in `EXPECTED_ROUTE_TREE`, and no
 * second response shape for the client to learn. The reason that decided it is the
 * widget's: with the block here it can say *memory alerts are off because this container
 * reports no limit* instead of drawing a gauge that silently means nothing. This is also
 * the one place the two consumers of `resources.service.ts` meet — the sampler does not
 * know the watchdog exists and vice versa, and joining them here is what keeps that true.
 *
 * Every string in the block is a **code from a closed set** or an ISO-8601 timestamp,
 * never prose, for the same reason the figures are raw numbers: the interface is
 * translated client-side, so `"memory.max is the literal max"` in a JSON body is a
 * sentence that can only ever be English.
 *
 * Not exempt from anything. Unlike `/healthz` this route is inside the base path and
 * behind a session, so neither the `Host` check nor the per-session rate-limit bucket
 * has a reason to skip it. At the intended two-second poll it costs 30 requests a
 * minute against a bucket that refills 240 a minute, and every request is served from
 * the sampler's cache.
 */
export default async function metricsRoutes(
  app: FastifyInstance,
  opts: { metrics: ResourceSampler; watchdog: Watchdog },
): Promise<void> {
  app.get('/api/metrics', { preHandler: requireFullSession }, async () => {
    const response: MetricsResponse = {
      ...opts.metrics.snapshot(),
      watchdog: opts.watchdog.status(),
    };
    return response;
  });
}
