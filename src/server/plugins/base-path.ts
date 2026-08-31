import type { FastifyPluginAsync } from 'fastify';
import type { IncomingMessage } from 'node:http';
import fp from 'fastify-plugin';
import { firstPathSegment, pathnameOf, timingSafeEqualStrings } from '../utils/timing-safe.js';

interface BasePathOptions {
  basePath: string;
}

/**
 * Every request whose first path segment is not the base path is rewritten to
 * this single constant before routing, so the router traverses an identical URL
 * for every rejected request and returns the generic 404. Nothing is mounted
 * here; a client asking for it directly is itself rewritten to it.
 */
export const NOT_FOUND_SINK = '/__panel_not_found';

/** The only path served outside the base path. */
export const HEALTHZ_PATH = '/healthz';

/**
 * Builds the `rewriteUrl` hook that gates the secret base path (F7).
 *
 * `rewriteUrl` is the one Fastify hook that runs *before* routing, which matters
 * here: find-my-way's radix traversal is not constant-time, so a gate placed in
 * `onRequest` would run after the router had already produced a measurable
 * partial-match signal. Rejecting here means every wrong prefix — regardless of
 * how many leading characters it got right — is collapsed onto one constant URL
 * and takes the same path through the router.
 *
 * Matching requests are returned unchanged rather than rewritten onto an
 * internal mount, so `req.url` stays truthful and anything that derives a URL
 * from it (redirects, `@fastify/static` in Phase 2) keeps emitting links a
 * browser can follow.
 *
 * The comparison is on the raw, undecoded segment: `/%73ecret` is a miss, not a
 * hit. That is deliberate — canonicalising first would open the door to the
 * class of prefix-confusion bypasses that @fastify/static v7 was vulnerable to.
 */
export function createBasePathGate(basePath: string): (req: IncomingMessage) => string {
  return function rewriteUrl(req: IncomingMessage): string {
    const rawUrl = req.url ?? '/';
    const pathname = pathnameOf(rawUrl);

    // /healthz is public and constant — no secret to protect, plain compare.
    if (pathname === HEALTHZ_PATH) return rawUrl;

    const segment = firstPathSegment(pathname);
    if (segment === null) return NOT_FOUND_SINK;
    if (!timingSafeEqualStrings(segment, basePath)) return NOT_FOUND_SINK;

    return rawUrl;
  };
}

/** Escapes a string for interpolation into a double-quoted HTML attribute. */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The bootstrap script body (F1).
 *
 * This cannot be an inline `<script>`: the CSP is `script-src 'self'` with no
 * `unsafe-inline`, so the browser refuses to execute it. A CSP hash is not an
 * option either — the script embeds the base path, which differs per install,
 * so any hash committed to the repo would only ever be correct on the machine
 * that generated it.
 *
 * `JSON.stringify` rather than string concatenation: `PANEL_BASE_PATH` is
 * operator-supplied and unvalidated, so it must not be able to terminate the
 * string literal.
 */
export function renderBootstrapScript(basePath: string): string {
  return `window.__BASE__ = ${JSON.stringify(`/${basePath}`)};\n`;
}

export function renderPlaceholderHtml(basePath: string): string {
  const bootstrapSrc = escapeHtmlAttribute(`/${basePath}/bootstrap.js`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Panel Shell</title>
  <!-- Must stay first and stay blocking: the Phase 2 bundle is a module, and
       modules are deferred, so a classic script here always runs first and the
       base path is on the window before the app boots. -->
  <script src="${bootstrapSrc}"></script>
</head>
<body>
  <h1>Panel shell — Phase 2</h1>
</body>
</html>`;
}

const basePathPlugin: FastifyPluginAsync<BasePathOptions> = async (fastify, opts) => {
  const { basePath } = opts;
  const bootstrapScript = renderBootstrapScript(basePath);
  const placeholderHtml = renderPlaceholderHtml(basePath);

  // Register a scoped plugin that all app routes will be registered under
  await fastify.register(
    async (scopedApp) => {
      // Placeholder route for Phase 2
      scopedApp.get('/', async (_req, reply) => {
        return reply.type('text/html; charset=utf-8').send(placeholderHtml);
      });

      // Base path bootstrap: the only way to hand window.__BASE__ to the client
      // under a strict CSP. Never cached — the base path can be regenerated.
      scopedApp.get('/bootstrap.js', async (_req, reply) => {
        return reply
          .type('application/javascript; charset=utf-8')
          .header('Cache-Control', 'no-store')
          .send(bootstrapScript);
      });
    },
    { prefix: `/${basePath}` }
  );
};

export default fp(basePathPlugin, {
  name: 'base-path',
});
