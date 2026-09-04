import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

/**
 * The panel's one outbound HTTP client.
 *
 * Everything that leaves this process goes through here: the Telegram transport now,
 * and M2.6's "test this API key" action next — which is the reason it is a utility and
 * not a private function inside the transport.
 *
 * **Why undici and not the global `fetch`.** Node's global `fetch` ignores `http_proxy`
 * and `https_proxy` entirely. That is not a bug and it is not going to change: the
 * WHATWG spec has no concept of a proxy. This operator's machine sets both variables,
 * and `api.telegram.org` is not reachable from their country without one — so a
 * transport built on the global `fetch` works on Railway, fails locally, and fails with
 * a network error that looks exactly like a wrong bot token. The proxy has to be wired
 * explicitly, which means an undici `ProxyAgent`, which means undici's own `fetch`: a
 * dispatcher from the standalone package is not the same object graph as the one baked
 * into Node, and pairing them is not a supported combination.
 *
 * **Two failure classes, deliberately not one.** A request that never reached the other
 * end (`unreachable`) and a request the other end answered and refused (`rejected`) call
 * for completely different sentences in front of a non-expert operator, and the whole
 * "is my token wrong?" confusion above is what happens when they are collapsed. This
 * module owns the first; the caller reads a status code for the second.
 */

/** How long an outbound request may take before it is abandoned. */
export const OUTBOUND_TIMEOUT_MS = 15_000;

export interface OutboundInit {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  /**
   * A JSON string, or raw bytes for a multipart upload.
   *
   * Bytes rather than a `FormData`: the global `FormData` and the one the standalone
   * undici package validates against are two different classes, and pairing them is a
   * runtime brand check waiting to fail. The one multipart caller builds its own body,
   * which also means the sentinel sweep can assert on exactly the bytes that left.
   */
  body?: string | Uint8Array;
  timeoutMs?: number;
}

export interface OutboundResponse {
  status: number;
  text(): Promise<string>;
}

export type OutboundFetch = (url: string, init: OutboundInit) => Promise<OutboundResponse>;

/**
 * A request that never got an answer: DNS, connect, TLS, or the timeout above.
 *
 * **Carries a code, never the underlying message, and never the URL.** The Telegram
 * URL has the bot token in its path (`/bot<token>/sendMessage`), so an error that
 * quoted the URL it failed on would put the token into whatever log line reported it.
 * `code` is the small vocabulary Node uses — `ENOTFOUND`, `ECONNREFUSED`,
 * `UND_ERR_CONNECT_TIMEOUT` — which is what an operator needs and all they need.
 */
export class OutboundUnreachableError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`outbound request could not be completed (${code})`);
    this.name = 'OutboundUnreachableError';
    this.code = code;
  }
}

/** Digs the most specific error code out of an undici failure without quoting it. */
function codeOf(err: unknown): string {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    current = (current as { cause?: unknown }).cause;
  }
  if (err instanceof Error && err.name === 'TimeoutError') return 'UND_ERR_ABORTED';
  return 'UNKNOWN';
}

export interface OutboundOptions {
  /** `PANEL_OUTBOUND_PROXY`. Unset means a direct connection. */
  proxyUrl?: string | undefined;
  timeoutMs?: number;
}

/**
 * Builds the fetch every outbound call goes through.
 *
 * One dispatcher per client, created once and reused, so a burst of notifications does
 * not open a connection pool per message.
 */
export function createOutboundFetch(opts: OutboundOptions = {}): OutboundFetch {
  const timeoutMs = opts.timeoutMs ?? OUTBOUND_TIMEOUT_MS;
  const dispatcher: Dispatcher =
    opts.proxyUrl !== undefined && opts.proxyUrl.length > 0
      ? new ProxyAgent({ uri: opts.proxyUrl, connectTimeout: timeoutMs })
      : new Agent({ connectTimeout: timeoutMs });

  return async (url, init) => {
    try {
      const response = await undiciFetch(url, {
        method: init.method,
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        dispatcher,
        signal: AbortSignal.timeout(init.timeoutMs ?? timeoutMs),
      });
      return { status: response.status, text: () => response.text() };
    } catch (err) {
      throw new OutboundUnreachableError(codeOf(err));
    }
  };
}

/**
 * Whether a configured proxy is worth warning about at boot.
 *
 * A production panel routing its notifications through an unexpected hop is far more
 * likely a variable copied from a development environment than a plan — and the hop can
 * read every outbound request, including the one with the bot token in its URL. A
 * warning, not a refusal: an operator may legitimately have an egress proxy, and boot
 * failures are not the place to argue about it. The **value is never in the message.**
 */
export function proxyBootWarning(proxyUrl: string | undefined, nodeEnv: string): string | null {
  if (proxyUrl === undefined || proxyUrl.length === 0) return null;
  if (nodeEnv !== 'production') return null;

  let host: string;
  try {
    host = new URL(proxyUrl).hostname;
  } catch {
    return null; // env.ts already refused to boot on this.
  }
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (loopback) return null;

  return (
    'PANEL_OUTBOUND_PROXY points at a non-loopback host in production. Every outbound ' +
    'notification — including the request that carries the Telegram bot token in its ' +
    'URL — is visible to that hop. Remove the variable if it was not deliberate.'
  );
}
