import type { ErrorCode, ErrorResponse } from '../../shared/types.js';
import { isErrorCode } from '../../shared/types.js';

/**
 * The only place in the client that speaks HTTP.
 *
 * Everything a screen needs to get wrong lives here once: the base path, the CSRF pair, the
 * 401 that means *sign in again*, the 403 that means *confirm it is you*, and the 429 that
 * means *wait* rather than *failed*. A component that built its own `fetch` would have to get
 * all five right, and would get the fifth wrong.
 *
 * ── Four rules, none of them negotiable ─────────────────────────────────────
 *
 * 1. **The base path comes from `window.__BASE__`**, which `bootstrap.js` set. It is secret and
 *    per-installation; nothing in the bundle may contain it, and nothing but this file may
 *    build a URL.
 * 2. **The CSRF cookie is read by the name the server gave**, `window.__CSRF_COOKIE__`. It is
 *    `__Secure-panel_csrf` over https and `panel_csrf` over loopback http, and
 *    `plugins/cookies.ts` is the only file allowed to decide which — so a hard-coded name
 *    would work on one deployment and 403 on every mutation on the other, with a
 *    correct-looking cookie in the jar and nothing in the console.
 * 3. **No body is ever logged.** Not on failure, not in development. The bodies here include a
 *    password, a TOTP secret, ten recovery codes and a revealed credential; `console.log` in a
 *    browser is a buffer somebody else's extension can read.
 * 4. **`credentials: 'same-origin'`**, explicitly. The default for `fetch` is `same-origin`
 *    already, but the cookie *is* the authentication here and a default that changed under us
 *    would be a silent logout on every request.
 */

/** What a caller catches. Carries the code, never a server-written sentence. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  /** Whole seconds, from `Retry-After`, when the server said to wait. */
  readonly retryAfterSeconds: number | null;

  constructor(status: number, code: ErrorCode, retryAfterSeconds: number | null = null) {
    // The message is for a stack trace in a devtools pane, never for display: every sentence
    // the operator reads comes from the dictionary, keyed by `code`.
    super(`api ${status} ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The panel could not be reached at all — DNS, TLS, offline, a killed container. */
export class NetworkError extends Error {
  readonly code = 'network' as const;

  constructor() {
    // No cause, and no message from the underlying error: a `TypeError: Failed to fetch`
    // reads as a bug in the panel, and the operator's next move is the same either way.
    super('api unreachable');
    this.name = 'NetworkError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * What the client does when the server says the session is gone, or that this action needs a
 * fresh confirmation.
 *
 * Registered by the shell rather than imported by it, because the alternative is a circular
 * import between the API layer and the component that renders a dialog. `onUnauthenticated`
 * drops to the login screen; `onStepUpRequired` opens the prompt and resolves `true` once the
 * step-up succeeded.
 */
export interface ApiHandlers {
  onUnauthenticated?: () => void;
  onStepUpRequired?: () => Promise<boolean>;
}

let handlers: ApiHandlers = {};

export function setApiHandlers(next: ApiHandlers): void {
  handlers = next;
}

function basePath(): string {
  const base = window.__BASE__;
  if (typeof base !== 'string' || base === '') {
    // This is the failure that presents as a blank page: `bootstrap.js` did not run, or ran and
    // was blocked by the CSP. Saying so is worth more than a stack of 404s.
    throw new Error('panel: window.__BASE__ is missing — bootstrap.js did not run');
  }
  return base;
}

/**
 * The double-submit token, read from the cookie the server set.
 *
 * Returns null rather than throwing when it is absent: a `GET` does not need it, and a request
 * with no session has no token to send — the server exempts both, and answering 401 for the
 * second is the route's job rather than this function's.
 */
export function readCsrfToken(): string | null {
  const name = window.__CSRF_COOKIE__;
  if (typeof name !== 'string' || name === '') return null;
  // A cookie value is percent-encoded by the server's serialiser, so it has to be decoded
  // before it goes into a header the server compares byte for byte.
  for (const part of document.cookie.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return rest.join('=');
      }
    }
  }
  return null;
}

interface RequestOptions {
  /** Suppress the automatic step-up retry. Used by the step-up call itself. */
  noStepUp?: boolean;
  /** Suppress the drop-to-login on 401. Used by `me()`, which asks *whether* there is one. */
  noRedirect?: boolean;
  signal?: AbortSignal;
}

async function send<T>(
  method: Method,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  // Safe methods are exempt server-side, so the header is sent only where it is checked.
  if (method !== 'GET') {
    const token = readCsrfToken();
    if (token !== null) headers['X-CSRF-Token'] = token;
  }

  let response: Response;
  try {
    response = await fetch(`${basePath()}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      // Never follow a redirect: every route here answers with JSON, and a redirect would mean
      // something has been put in front of the panel that the CSP and the origin check have
      // not been told about.
      redirect: 'error',
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (err) {
    // An abort is the caller's own doing and must not be reported as the panel being down.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new NetworkError();
  }

  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  const code = await codeOf(response);

  // ── 403 step_up_required: prompt, then retry exactly once ────────────────
  //
  // Once, and only for this code. A loop would turn a step-up the operator keeps cancelling
  // into a dialog they cannot escape, and retrying any other 403 would retry a CSRF failure
  // that will fail identically. The retry is marked `noStepUp` so a second 403 propagates.
  if (
    response.status === 403 &&
    code === 'step_up_required' &&
    options.noStepUp !== true &&
    handlers.onStepUpRequired !== undefined
  ) {
    const granted = await handlers.onStepUpRequired();
    if (granted) return send<T>(method, path, body, { ...options, noStepUp: true });
  }

  if (response.status === 401 && options.noRedirect !== true) {
    // The session is gone — expired, revoked from another device, or rotated out from under a
    // stale tab. The shell drops to the login screen; the throw still happens, so the caller
    // does not carry on as though it had data.
    handlers.onUnauthenticated?.();
  }

  const retryAfter = response.headers.get('retry-after');
  const seconds = retryAfter === null ? null : Number.parseInt(retryAfter, 10);
  throw new ApiError(
    response.status,
    code,
    seconds !== null && Number.isFinite(seconds) ? seconds : null,
  );
}

/**
 * The code, or the closest honest guess.
 *
 * The body is always `{error, code}` from `app.setErrorHandler` — but "always" is a claim about
 * the server, and this runs in a browser that may have been handed something else entirely by
 * a proxy in front of the panel. An unparseable body maps to the status rather than throwing a
 * second error on top of the first.
 */
async function codeOf(response: Response): Promise<ErrorCode> {
  try {
    const body = (await response.json()) as ErrorResponse;
    if (isErrorCode(body.code)) return body.code;
  } catch {
    /* not JSON, or empty */
  }
  switch (response.status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'too_large';
    case 429:
      return 'rate_limited';
    default:
      return 'server_error';
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions): Promise<T> =>
    send<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    send<T>('POST', path, body, options),
  put: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    send<T>('PUT', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    send<T>('PATCH', path, body, options),
  del: <T>(path: string, options?: RequestOptions): Promise<T> =>
    send<T>('DELETE', path, undefined, options),
};
