import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';

/**
 * Driving a **real HTTP client** at an in-process server.
 *
 * `app.inject()` is a perfectly good way to exercise a handler, but it is not a
 * client: it never parses a `Set-Cookie`, never decides whether a cookie is in
 * scope for a path, never reads a cookie back out to echo it in a header, and it
 * synthesises the `Host` header from the URL it was given. Those are exactly the
 * steps the CSRF and Origin/Host controls depend on, so the tests that prove those
 * two use curl and a real cookie jar against a real listening socket.
 *
 * Two things about pointing a real client at an in-process server, both learned
 * the hard way:
 *
 * - **curl must run asynchronously.** `execFileSync` blocks the Node event loop,
 *   and the server under test is on that loop, so a synchronous curl deadlocks:
 *   the request sits in the socket buffer until curl's own timeout fires.
 * - **`--noproxy '*'`.** A developer machine with `http_proxy` set — this one has
 *   one — sends even `http://127.0.0.1` through the proxy, which answers with its
 *   own error page and no cookies. The test would fail for a reason that has
 *   nothing to do with the panel.
 */

const execFileAsync = promisify(execFile);

export interface CurlResult {
  status: number;
  body: string;
}

/** One curl invocation. Status comes back through `-w`, appended after the body. */
export async function curl(args: string[]): Promise<CurlResult> {
  const full = [
    '-sS',
    // Never through a proxy: the target is loopback and the operator's environment
    // must not be able to change what this test is talking to.
    '--noproxy',
    '*',
    '--max-time',
    '20',
    // No `-f`: an HTTP 403 is the expected outcome of most of these calls and must
    // not become a non-zero exit that throws before the status can be read.
    '-w',
    '\n%{http_code}',
    ...args,
  ];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('curl', full, { encoding: 'utf8' }));
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    throw new Error(`curl failed (exit ${String(e.status)}): ${e.stderr ?? ''}`);
  }
  const cut = stdout.lastIndexOf('\n');
  return { status: Number(stdout.slice(cut + 1).trim()), body: stdout.slice(0, cut) };
}

/**
 * Reads one cookie's value out of a curl jar file.
 *
 * The jar is the Netscape format: tab-separated, and an `HttpOnly` cookie has its
 * domain field prefixed with `#HttpOnly_` — which is also why a naive "skip lines
 * starting with #" parser silently cannot see the session cookie.
 */
export function fromJar(jar: string, name: string): string {
  const text = readFileSync(jar, 'utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;
    const fields = line.replace(/^#HttpOnly_/, '').split('\t');
    if (fields.length >= 7 && fields[5] === name) return fields[6]!;
  }
  throw new Error(`cookie ${name} is not in the jar:\n${text}`);
}

/**
 * Binds the app to an ephemeral loopback port and returns its `http://` root.
 *
 * Port 0 rather than a fixed one so files can run in parallel; 127.0.0.1 rather
 * than a wildcard so nothing on the network can reach a test server.
 */
export async function listenLoopback(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server did not bind a TCP port');
  }
  return `http://127.0.0.1:${address.port}`;
}
