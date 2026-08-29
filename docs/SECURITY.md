# Security Model — Implementation Map

This document maps each security control to the file that implements it and the
test that pins it down. It grows with each milestone; sections marked *(not yet
implemented)* are placeholders for later milestones so the mapping stays complete.

## Response Headers

Every response, on every route, carries the same header set. The set is defined in
one place — `SECURITY_HEADERS` in `src/server/plugins/security-headers.ts` — and
applied from a single `onSend` hook registered with `fastify-plugin`, so it covers
the base-path scope, `/healthz`, error responses, and the generic 404 alike.

| Header | Value | Why |
| --- | --- | --- |
| `Content-Security-Policy` | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` | Deny-by-default. No `unsafe-inline`, no `unsafe-eval`, identical in dev and production so a CSP violation cannot be a production-only surprise. |
| `X-Content-Type-Options` | `nosniff` | Stops MIME sniffing from turning a JSON or text response into something executable. |
| `X-Frame-Options` | `DENY` | Legacy belt to the `frame-ancestors 'none'` braces above, for anything that predates CSP framing controls. |
| `Referrer-Policy` | `no-referrer` | **The panel URL contains the secret base path.** `no-referrer` is the only value that guarantees the path never appears in an outbound `Referer` header — `strict-origin-when-cross-origin` still sends the origin, and same-origin navigations would carry the full path. Nothing in this application reads `Referer`. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Severs the `window.opener` relationship with cross-origin documents, so a page that opens the panel cannot reach into it. |
| `Cross-Origin-Resource-Policy` | `same-origin` | Blocks cross-origin `no-cors` embedding of panel responses, closing off the read-by-side-channel variants of Spectre-style leaks. |
| `Permissions-Policy` | `accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=()` | Every powerful feature this panel has no use for, denied. Alphabetical so the value is byte-stable. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Production only. Sending it over plain HTTP in development would pin `localhost` to HTTPS in the developer's browser. |

### Headers deliberately absent

| Header | Why not |
| --- | --- |
| `X-XSS-Protection` | It controlled Chrome's XSS Auditor and IE's XSS filter. Both have been removed from every shipping browser, it was never specified, and while it existed its filtering was itself an information-leak and script-injection primitive. `1; mode=block` — the value this project previously sent — is the worst available option, because it opts *in* to that legacy behaviour on anything that still honours it. The strict CSP is the real control, so the header is omitted entirely rather than sent as `0`. |
| `Server`, `X-Powered-By` | Neither Node's HTTP server nor Fastify emits them by default. There is nothing to remove, only something to keep from coming back — hence the regression test below. |
| `Cross-Origin-Embedder-Policy` | Not needed yet. It would be required to enable `SharedArrayBuffer` or cross-origin isolation; nothing here uses either. |

### Tests

`tests/integration/perimeter.test.ts` asserts the **complete** header map
byte-for-byte, not merely that headers are present, on five response shapes: the
placeholder page (200 HTML), the bootstrap script (200 JS), the generic 404,
`/healthz`, and a deliberate 500. `date`, `content-length`, and `connection` are
excluded from the exact comparison and asserted separately; everything else must
match exactly, so the test fails if a value changes, a header disappears, **or an
unexpected header appears**.

The expected values are written out as literals in the test rather than imported
from the plugin. This is deliberate. The previous suite had twenty-five green
tests while four header values were wrong or missing, because it only checked
that headers existed; importing the constants would reintroduce the same blind
spot from the other direction, with the test simply agreeing with whatever the
plugin happened to say.

## Secret Base Path

- Resolution and persistence: `resolveBasePath()` in `src/server/app.ts`,
  persisted to `/data/config/instance.json`, printed once at first boot.
- Route mounting: `src/server/plugins/base-path.ts` registers the whole
  application under `/${basePath}`. `GET /healthz` is the only route outside it.
- Generic 404: `app.setNotFoundHandler` in `src/server/app.ts` returns a fixed
  `{"error":"Not Found"}` body with no hint that a prefix exists.

### Constant-time gate

`createBasePathGate()` in `src/server/plugins/base-path.ts` is installed as
Fastify's `rewriteUrl` option. `rewriteUrl` is the only Fastify hook that runs
*before* routing, which is the point: find-my-way's radix traversal is not
constant-time, so a gate in `onRequest` would run after the router had already
produced a measurable partial-match signal.

The gate compares the request's first path segment to the base path with
`crypto.timingSafeEqual` over equal-length buffers
(`src/server/utils/timing-safe.ts`), length first and then bytes. Requests that
match are returned **unchanged**, so `req.url` stays truthful and anything that
derives a URL from it — redirects, `@fastify/static` in Phase 2 — keeps emitting
links a browser can follow. Every request that does not match is collapsed onto a
single constant sink URL, so all rejected requests take an identical path through
the router and produce an identical 404 regardless of how many leading characters
they got right.

Two properties are accepted rather than fixed:

- **The base path's length leaks.** `crypto.timingSafeEqual` throws on
  mismatched lengths, so the length check cannot be avoided. The length is not
  secret: generated base paths are always 22 characters.
- **The comparison is on the raw, undecoded segment.** `/%73ecret` is a miss,
  not a hit. Canonicalising first is exactly what opens the door to the
  prefix-confusion bypass class that `@fastify/static` v7 was vulnerable to.

Covered by `tests/unit/timing-safe.test.ts` (the gate function against raw
request targets, including non-normalised `..` paths that `app.inject()` cannot
express) and `tests/integration/base-path.test.ts` (near-miss prefixes of
increasing accuracy all producing a byte-identical 404).

## Client Bootstrap

The client needs the base path before it boots, and the CSP is `script-src 'self'`
with no `unsafe-inline`, so an inline `<script>window.__BASE__=...</script>` is
blocked by the browser and leaves `window.__BASE__` undefined.

A CSP hash is not an acceptable fix: the script body embeds the base path, which
differs per installation, so any hash committed to the repository would only ever
be correct on the machine that generated it.

Instead, `GET /${basePath}/bootstrap.js` serves the assignment as a same-origin
file with `Content-Type: application/javascript; charset=utf-8` and
`Cache-Control: no-store` (the base path can be regenerated, so it must never be
cached). The placeholder HTML references it with a plain `src` attribute, first in
`<head>` and deliberately not `defer`/`async`/`type=module` — the Phase 2 bundle
will be a module, modules are always deferred, so a blocking classic script here
is guaranteed to run first.

`PANEL_BASE_PATH` is operator-supplied and unvalidated, so the value is
`JSON.stringify`-encoded into the script body and HTML-attribute-escaped into the
`src`. `<base href>` is not an option for making the reference relative: the CSP
sets `base-uri 'none'`.

## Manual Browser Checks

The automated suite runs against `app.inject()`. It can assert what the server
sends, but it cannot assert what a browser *does* with it: no CSP is evaluated, no
script is executed, and hop-by-hop headers added on a real socket never appear.
The following must be checked by hand in a real browser after any change to the
CSP, the header set, or the bootstrap path, and before any deployment.

1. **Zero CSP violations in the console.** Open `https://<host>/<basePath>/` with
   DevTools on the Console tab. There must be no message containing "Content
   Security Policy". In particular there must be no "Refused to execute inline
   script" — that is the F1 regression, and it is invisible to the test suite
   because `inject()` does not evaluate CSP.
2. **`window.__BASE__` is defined.** Type `window.__BASE__` in the console. It
   must print `"/<basePath>"`, not `undefined`. Also confirm in the Network tab
   that `bootstrap.js` returned 200 with `Cache-Control: no-store`, and that it
   appears *before* any application bundle.
3. **The header set matches exactly.** In the Network tab, select the document
   request and read the response headers. Compare against the table at the top of
   this document. There must be no `X-XSS-Protection`, no `Server`, and no
   `X-Powered-By`. `Strict-Transport-Security` must be present in production and
   absent in local development. Transport headers a real connection adds
   (`Connection`, `Keep-Alive`, and `Proxy-Connection` behind a proxy) are not
   part of the application header set and are expected.
4. **Deep-link hard refresh.** Once the SPA router lands in Phase 2, hard-refresh
   on a deep route and confirm the base path survives and no CSP violation
   appears.
5. **Reduced motion.** With `prefers-reduced-motion: reduce` set at the OS level,
   confirm no animation runs (Phase 2, once there is anything animated).

## Not Yet Implemented

These are listed so the map stays complete; each will be filled in with its
milestone.

- HKDF subkey derivation, AES-256-GCM encryption, `SecretString`, secret
  masking, logger redaction, secret repository — M1.3.
- Password hashing (argon2id) and the constant-time dummy-hash path — M1.4.
- Server-side sessions, opaque tokens, SHA-256-at-rest — M1.4.
- TOTP and recovery codes — M1.4.
- CSRF double-submit token and strict `Origin` validation — M1.4.
- Progressive per-IP and per-account lockout — M1.4.
- Rate limiting and request size limits — M1.4.
- Audit log — M1.4.
