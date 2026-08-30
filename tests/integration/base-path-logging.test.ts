import { describe, it, expect, afterEach } from 'vitest';
import {
  createTestServer,
  createLogCapture,
  type TestContext,
} from '../helpers/test-server.js';
import {
  BASE_PATH_PLACEHOLDER,
  createBasePathElider,
} from '../../src/server/plugins/logger-redaction.js';

/**
 * A base path long and distinctive enough that finding it in a log line is
 * unambiguous, and shaped like a generated one (base64url, 22 characters).
 */
const BASE = 'Zq7XmT4bLp9wKd2NrS6vHy';

describe('M1.2 — the base path never reaches a log line', () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  describe('createBasePathElider', () => {
    it('replaces the raw value with the fixed placeholder', () => {
      const elide = createBasePathElider(BASE);
      expect(elide(`/${BASE}/api/foo`)).toBe(`/${BASE_PATH_PLACEHOLDER}/api/foo`);
      expect(elide(BASE)).toBe(BASE_PATH_PLACEHOLDER);
      expect(elide(`Path=/${BASE}; HttpOnly`)).toBe(
        `Path=/${BASE_PATH_PLACEHOLDER}; HttpOnly`,
      );
    });

    it('replaces every occurrence, not just the first', () => {
      const elide = createBasePathElider(BASE);
      expect(elide(`/${BASE}/a /${BASE}/b`)).toBe(
        `/${BASE_PATH_PLACEHOLDER}/a /${BASE_PATH_PLACEHOLDER}/b`,
      );
    });

    it('replaces the percent-encoded spelling', () => {
      const elide = createBasePathElider('a b/c');
      expect(elide('/a%20b%2Fc/x')).toBe(`/${BASE_PATH_PLACEHOLDER}/x`);
    });

    it('replaces the JSON-escaped spelling', () => {
      // PANEL_BASE_PATH is operator-supplied and unvalidated, so it can contain
      // characters pino will escape on its way into the log line.
      const elide = createBasePathElider('a"b\\c');
      expect(elide(JSON.stringify({ url: '/a"b\\c/x' }))).toBe(
        `{"url":"/${BASE_PATH_PLACEHOLDER}/x"}`,
      );
    });

    it('leaves unrelated text alone and is a no-op for an empty base path', () => {
      expect(createBasePathElider(BASE)('/healthz')).toBe('/healthz');
      expect(createBasePathElider('')('anything')).toBe('anything');
    });

    it('never lets a caller-supplied placeholder reintroduce the match', () => {
      // A string replacement would expand `$&` back into the base path.
      expect(createBasePathElider(BASE, '$&')(`/${BASE}/x`)).toBe('/$&/x');
    });
  });

  describe('through the server logger', () => {
    it('logs a valid request with the prefix elided', async () => {
      const capture = createLogCapture();
      ctx = await createTestServer({ PANEL_BASE_PATH: BASE }, { logTarget: capture.target });

      const res = await ctx.app.inject({ method: 'GET', url: `/${BASE}/bootstrap.js?x=1` });
      expect(res.statusCode).toBe(200);

      const text = capture.text();
      expect(text.length).toBeGreaterThan(0);
      expect(text, 'base path in a log line').not.toContain(BASE);

      // The request line is still useful: the path after the prefix survives.
      const incoming = capture
        .lines()
        .find((line) => line.msg === 'incoming request') as
        | { req: { url: string; method: string } }
        | undefined;
      expect(incoming).toBeDefined();
      expect(incoming!.req.url).toBe(`/${BASE_PATH_PLACEHOLDER}/bootstrap.js?x=1`);
      expect(incoming!.req.method).toBe('GET');

      // And the response line was emitted, so response logging is covered too.
      expect(capture.lines().some((line) => line.msg === 'request completed')).toBe(true);
    });

    it('elides the prefix from an error log and its stack', async () => {
      const capture = createLogCapture();
      ctx = await createTestServer(
        { PANEL_BASE_PATH: BASE },
        {
          logTarget: capture.target,
          beforeReady: (app) => {
            app.get(`/${BASE}/__throw`, async () => {
              // An error message is one of the easiest ways for a URL to reach a
              // log line, and the stack carries the route path too.
              throw new Error(`upstream call to /${BASE}/api/foo failed`);
            });
          },
        },
      );

      const res = await ctx.app.inject({ method: 'GET', url: `/${BASE}/__throw` });
      expect(res.statusCode).toBe(500);

      const text = capture.text();
      expect(text).toContain('request failed');
      expect(text, 'base path in an error log').not.toContain(BASE);
      expect(text).toContain(`/${BASE_PATH_PLACEHOLDER}/api/foo`);
    });

    it('elides the prefix from a hand-built log message on any code path', async () => {
      const capture = createLogCapture();
      ctx = await createTestServer(
        { PANEL_BASE_PATH: BASE },
        {
          logTarget: capture.target,
          beforeReady: (app) => {
            app.get(`/${BASE}/__log`, async (req, reply) => {
              // Not a serialiser path: a string a call site built by hand, and a
              // nested object value. Both must be covered.
              req.log.info(`serving /${BASE}/__log by hand`);
              req.log.warn({ nested: { where: `/${BASE}/deep` } }, 'nested');
              return reply.send({ ok: true });
            });
          },
        },
      );

      await ctx.app.inject({ method: 'GET', url: `/${BASE}/__log` });

      const text = capture.text();
      expect(text).not.toContain(BASE);
      expect(text).toContain(`/${BASE_PATH_PLACEHOLDER}/__log`);
      expect(text).toContain(`/${BASE_PATH_PLACEHOLDER}/deep`);
    });

    it('does not log the prefix for a request that never matched it', async () => {
      const capture = createLogCapture();
      ctx = await createTestServer({ PANEL_BASE_PATH: BASE }, { logTarget: capture.target });

      await ctx.app.inject({ method: 'GET', url: '/wrong-prefix/api/foo' });

      const text = capture.text();
      expect(text).not.toContain(BASE);
      // The pre-routing gate collapsed it onto the sink, so that is what is
      // logged — a rejected request's original path is not retained either.
      expect(text).toContain('__panel_not_found');
    });
  });
});
