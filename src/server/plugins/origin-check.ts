import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { Env } from '../env.js';
import { HEALTHZ_PATH } from './base-path.js';
import { isLoopbackHostname, type PublicOrigin } from '../utils/public-origin.js';
import { pathnameOf } from '../utils/timing-safe.js';
import { HttpError } from './auth.js';

/** Methods that can change state. `GET`, `HEAD` and `OPTIONS` are excluded by definition. */
const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * What the validator needs from a request, and nothing more.
 *
 * Deliberately shaped like a raw `http.IncomingMessage` rather than a
 * `FastifyRequest`, because the Phase 3 terminal WebSocket arrives as an HTTP
 * upgrade that never becomes a Fastify request. **That handler must call
 * {@link validateRequestOrigin} itself** — a socket upgrade is a state-changing,
 * cookie-authenticated operation that `SameSite` protects but that no Fastify
 * `onRequest` hook will ever see. See CLAUDE.md.
 */
export interface OriginCheckInput {
  method: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  /** Raw request URL, query and all. Only the path is used. */
  url: string | undefined;
}

export type OriginRejectionReason =
  | 'host_missing'
  | 'host_mismatch'
  | 'origin_mismatch'
  | 'scheme_downgrade';

export type OriginVerdict = { ok: true } | { ok: false; reason: OriginRejectionReason };

/**
 * The expected origin, resolved from configuration exactly once.
 *
 * `production` and `trustProxy` are folded in here so no caller re-reads
 * `process.env` — the cookie profile and this check must never disagree about what
 * the public origin is, so both take it from the single `PublicOrigin` that
 * `buildServer` resolves at boot.
 */
export interface OriginPolicy {
  readonly origin: PublicOrigin;
  readonly trustProxy: boolean;
  readonly production: boolean;
}

export function createOriginPolicy(env: Env, origin: PublicOrigin): OriginPolicy {
  return { origin, trustProxy: env.PANEL_TRUST_PROXY, production: env.NODE_ENV === 'production' };
}

/**
 * The value of the hop nearest to us in a possibly-appended header.
 *
 * `X-Forwarded-*` accumulates left to right, so the *rightmost* element is the one
 * written by the proxy we are actually talking to and the only one that is not
 * attacker-supplied. Node exposes repeated headers as an array for some names and
 * as a comma-joined string for others, so both spellings are unpicked.
 */
function immediateHop(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  const joined = Array.isArray(raw) ? raw.join(',') : raw;
  const parts = joined.split(',');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const value = parts[i]!.trim();
    if (value.length > 0) return value;
  }
  return null;
}

/** A single-valued header. An array means a duplicated header: refuse to guess. */
function soleValue(raw: string | string[] | undefined): string | null {
  if (typeof raw === 'string') return raw.trim().length === 0 ? null : raw.trim();
  return null;
}

/**
 * Whether this request is a WebSocket handshake.
 *
 * A handshake is a `GET`, so the mutating-method test below would wave it through
 * with its `Origin` unexamined — and a socket upgrade is the most state-changing
 * thing this panel will ever do, since Phase 3 attaches a terminal to it. Browsers
 * send `Origin` on every WebSocket handshake, so there is a value to check; what is
 * missing is a reason to check it, and the method is not that reason. Matched on
 * the header rather than the method, tolerating the array spelling, because this is
 * the one case where being generous about the input is the safe direction.
 */
function isWebSocketUpgrade(raw: string | string[] | undefined): boolean {
  if (raw === undefined) return false;
  const values = Array.isArray(raw) ? raw : [raw];
  return values.some((value) =>
    value
      .split(',')
      .some((part) => part.trim().toLowerCase() === 'websocket'),
  );
}

/** Splits an authority into hostname and port, tolerating a bracketed IPv6 literal. */
export function splitAuthority(authority: string): { hostname: string; port: string | null } {
  const value = authority.trim();
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return { hostname: value, port: null };
    const hostname = value.slice(1, close);
    const rest = value.slice(close + 1);
    return { hostname, port: rest.startsWith(':') ? rest.slice(1) : null };
  }
  const colon = value.lastIndexOf(':');
  if (colon === -1) return { hostname: value, port: null };
  return { hostname: value.slice(0, colon), port: value.slice(colon + 1) };
}

function isLoopbackAuthority(authority: string): boolean {
  return isLoopbackHostname(splitAuthority(authority).hostname);
}

/**
 * Validates `Host` on every request and `Origin` on every state-changing request,
 * against the configured public origin.
 *
 * **The expected value is never derived from the request.** The previous
 * implementation compared `Origin` against `` `${req.protocol}://${req.host}` ``,
 * which is circular: an attacker who can make a browser send
 * `Host: evil.example` and `Origin: https://evil.example` satisfies it trivially,
 * and every absolute URL the application builds from `Host` — a password-reset
 * link, a redirect — points at the attacker's host. The expected origin now comes
 * from `PANEL_PUBLIC_URL` / `RAILWAY_PUBLIC_DOMAIN` / the development fallback,
 * resolved once at boot.
 *
 * Rules:
 *
 * - **Host** is checked on *every* method, because Host poisoning is not a
 *   mutation-only problem. `/healthz` is exempt: Docker's `HEALTHCHECK` reaches
 *   the container as `localhost:3000` while production's public host is something
 *   else, and a health probe that 403s is a container-kill primitive.
 * - Outside production any loopback authority is accepted, so `localhost:3000`,
 *   `127.0.0.1:3000` and `[::1]:3000` all work in development without
 *   configuration. In production the match is exact.
 * - **Origin** is checked on mutating methods and on a WebSocket handshake — see
 *   {@link isWebSocketUpgrade} for why the handshake needs naming explicitly — and
 *   an **absent** header is
 *   allowed — browsers attach `Origin` to every mutating request and every
 *   handshake, so absent means
 *   a non-browser client, which cannot be tricked into acting for someone else.
 *   A *present and wrong* header, including the literal `null` an opaque origin
 *   sends, is a 403.
 * - Outside production any loopback origin is accepted, which is what lets the
 *   Vite dev server on `:5173` talk to the API on `:3000` in M2.
 * - `X-Forwarded-Host` and `X-Forwarded-Proto` are honoured only when
 *   `PANEL_TRUST_PROXY` is on, and only their rightmost value.
 */
export function validateRequestOrigin(policy: OriginPolicy, req: OriginCheckInput): OriginVerdict {
  const pathname = pathnameOf(req.url ?? '/');
  const method = (req.method ?? 'GET').toUpperCase();

  if (pathname !== HEALTHZ_PATH) {
    const forwardedHost = policy.trustProxy ? immediateHop(req.headers['x-forwarded-host']) : null;
    const host = forwardedHost ?? soleValue(req.headers.host);
    if (host === null) return { ok: false, reason: 'host_missing' };
    if (host.toLowerCase() !== policy.origin.host.toLowerCase()) {
      if (policy.production || !isLoopbackAuthority(host)) {
        return { ok: false, reason: 'host_mismatch' };
      }
    }

    // A forwarded request that admits it arrived over plaintext, when the panel's
    // public origin is https, means the TLS terminator was bypassed. Only checked
    // when the proxy actually set the header, so a direct request in development
    // is unaffected.
    if (policy.origin.secure && policy.trustProxy) {
      const proto = immediateHop(req.headers['x-forwarded-proto']);
      if (proto !== null && proto.toLowerCase() !== 'https') {
        return { ok: false, reason: 'scheme_downgrade' };
      }
    }
  }

  if (!MUTATING_METHODS.has(method) && !isWebSocketUpgrade(req.headers.upgrade)) {
    return { ok: true };
  }

  const origin = soleValue(req.headers.origin);
  if (origin === null) return { ok: true };
  if (origin === policy.origin.origin) return { ok: true };
  if (!policy.production && origin !== 'null') {
    try {
      const parsed = new URL(origin);
      if (isLoopbackHostname(parsed.hostname)) return { ok: true };
    } catch {
      // Unparseable Origin: fall through to the rejection below.
    }
  }
  return { ok: false, reason: 'origin_mismatch' };
}

/**
 * The Fastify hook form. Must be installed at the **root** scope and *before* any
 * `register()` call, or Fastify's encapsulation will leave the children — the API
 * and the shell — without it.
 */
export function requireValidOriginAndHost(policy: OriginPolicy): onRequestAsyncHookHandler {
  return async function originAndHostHook(req: FastifyRequest): Promise<void> {
    const verdict = validateRequestOrigin(policy, {
      method: req.method,
      headers: req.raw.headers as Record<string, string | string[] | undefined>,
      url: req.raw.url,
    });
    if (!verdict.ok) {
      // The reason goes to the log, never to the client: the response is the bare
      // reason phrase from `app.setErrorHandler`.
      req.log.warn({ reason: verdict.reason }, 'request rejected by origin/host check');
      throw new HttpError(403, `request rejected: ${verdict.reason}`);
    }
  };
}
