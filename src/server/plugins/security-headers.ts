import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { Env } from '../env.js';

interface SecurityHeadersOptions {
  env: Env;
}

/**
 * CSP: identical in dev and production, no unsafe-inline or unsafe-eval.
 *
 * `connect-src 'self'` also covers same-origin WebSocket connections in modern
 * browsers (the WebSocket URL is matched against the document origin with the
 * scheme upgraded), so no explicit `wss:` source is listed. Phase 3 must confirm
 * this in a real browser when the terminal socket lands.
 */
export const CSP =
  "default-src 'none'; " +
  "script-src 'self'; " +
  "style-src 'self'; " +
  "img-src 'self' data:; " +
  "font-src 'self'; " +
  "connect-src 'self'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'none'; " +
  "form-action 'self'";

/**
 * Every feature this panel has no use for, denied. Alphabetical so the value is
 * stable and the byte-for-byte header test stays readable.
 */
export const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'usb=()',
].join(', ');

export const HSTS = 'max-age=63072000; includeSubDomains; preload';

/**
 * The complete set of security headers sent on every response, dev and prod.
 * `Strict-Transport-Security` is added on top of this in production only.
 *
 * Deliberately absent:
 *
 * - `X-XSS-Protection`. It controlled Chrome's XSS Auditor and IE's XSS filter,
 *   both of which have been removed from every shipping browser. It was never
 *   specified, and while it existed its filtering was itself an information-leak
 *   and injection primitive. Sending `1; mode=block` is the worst option: it
 *   opts in to legacy behaviour on anything that still honours it. The strict CSP
 *   above is the real control, so the header is omitted entirely rather than sent
 *   as `0`.
 * - `Server` / `X-Powered-By`. Neither Node's http server nor Fastify emits them
 *   by default; `tests/integration/perimeter.test.ts` asserts they stay absent so
 *   a future plugin cannot reintroduce them silently.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // no-referrer, not strict-origin-when-cross-origin: this panel's URL contains
  // the secret base path, and no-referrer is the only value that guarantees the
  // path never reaches an outbound Referer header. Nothing here reads Referer.
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': PERMISSIONS_POLICY,
  'Content-Security-Policy': CSP,
});

const securityHeadersPlugin: FastifyPluginAsync<SecurityHeadersOptions> = async (fastify, opts) => {
  const isProduction = opts.env.NODE_ENV === 'production';

  fastify.addHook('onSend', async (_req, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }

    // HSTS only in production
    if (isProduction) {
      reply.header('Strict-Transport-Security', HSTS);
    }
  });
};

export default fp(securityHeadersPlugin, {
  name: 'security-headers',
});
