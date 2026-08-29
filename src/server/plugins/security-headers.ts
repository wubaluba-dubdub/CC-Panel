import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { Env } from '../env.js';

interface SecurityHeadersOptions {
  env: Env;
}

const securityHeadersPlugin: FastifyPluginAsync<SecurityHeadersOptions> = async (fastify, opts) => {
  const isProduction = opts.env.NODE_ENV === 'production';

  fastify.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '1; mode=block');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

    // CSP: identical in dev and production, no unsafe-inline or unsafe-eval
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );

    // HSTS only in production
    if (isProduction) {
      reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }
  });
};

export default fp(securityHeadersPlugin, {
  name: 'security-headers',
});
