import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';

/**
 * A local stand-in for `api.telegram.org`.
 *
 * A real listening socket rather than a mocked `fetch`, for the reason the CSRF suite
 * uses real `curl`: the assertion that matters most in this milestone is about **the
 * bytes that left the process**, and a mock records the arguments it was called with
 * instead. This captures the method, the path (which contains the bot token), the headers
 * and the raw body of every request.
 *
 * Nothing in the suite ever talks to Telegram.
 */

export interface CapturedRequest {
  method: string;
  /** `/bot<token>/sendMessage`. The token is in here, which is half the point. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** Parsed, for a JSON request. Null for multipart or anything unparseable. */
  json: Record<string, unknown> | null;
}

export interface FakeReply {
  status?: number;
  /** The JSON body. Defaults to `{ok: true, result: {}}`. */
  body?: unknown;
  /** Sent verbatim instead of `body`, for a non-JSON response. */
  raw?: string;
}

export interface FakeTelegram {
  readonly baseUrl: string;
  readonly requests: CapturedRequest[];
  /** Queue one reply per request, in order. Exhausted queue falls back to `ok: true`. */
  reply(reply: FakeReply): void;
  /** Reply to every request from now on. */
  always(reply: FakeReply): void;
  close(): Promise<void>;
}

export async function startFakeTelegram(): Promise<FakeTelegram> {
  const requests: CapturedRequest[] = [];
  const queue: FakeReply[] = [];
  let standing: FakeReply | null = null;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(body);
        json = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
      } catch {
        json = null;
      }
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body,
        json,
      });

      const reply = queue.shift() ?? standing ?? { status: 200, body: { ok: true, result: {} } };
      res.statusCode = reply.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(reply.raw ?? JSON.stringify(reply.body ?? { ok: true, result: {} }));
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    reply: (reply) => queue.push(reply),
    always: (reply) => {
      standing = reply;
    },
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}
