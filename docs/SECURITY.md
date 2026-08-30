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

### What it is, and what it is not

The base path is **obscurity, not a security boundary**. It keeps the panel out of
opportunistic scanners and out of anyone's browser history who was handed a link
by accident. It is not a credential: authentication is the boundary, and every
route that matters is behind a session. Nothing in this design assumes an attacker
who learns the base path is thereby locked out of anything.

That said, obscurity is only worth having if it is actually kept. Two places
previously gave it away for free, and both are now closed:

- **`Referer` on outbound navigation.** Handled by `Referrer-Policy: no-referrer`
  (see the header table above).
- **Retained logs.** This deploys to Railway, where stdout is retained and
  readable from the project dashboard for as long as the deployment exists. Pino's
  default `req` serialiser writes `req.url` verbatim, so every valid request
  printed the prefix into a log that outlives the request by weeks. An obscurity
  measure printed into a retained log is not obscurity, so it is elided — see
  below.

Deliberately still printed, once: the first-boot banner in `resolveBasePath()`
prints the generated base path to the console, because the operator has no other
way to learn it. That is a single line at first boot, not a per-request record,
and it is suppressed under `NODE_ENV=test`.

Also unavoidably carrying it: the `Path` attribute of the session `Set-Cookie`
header, and the shell HTML's `<script src>` (see *Client Bootstrap*). Both go only
to a client that fetched a URL containing the prefix, so neither discloses
anything the recipient did not already have.

### Resolution and routing

- Resolution and persistence: `resolveBasePath()` in `src/server/app.ts`,
  persisted to `/data/config/instance.json`, printed once at first boot.
- Route mounting: `src/server/plugins/base-path.ts` registers the whole
  application under `/${basePath}`. `GET /healthz` is the only route outside it.
- Generic 404: `app.setNotFoundHandler` in `src/server/app.ts` returns a fixed
  `{"error":"Not Found"}` body with no hint that a prefix exists.

### Elision from logs

Two layers, the same shape as the secret-redaction design: a structural control
plus a catch-all.

**Structural — pino serialisers.** `createBasePathSerializers()` in
`src/server/plugins/logger-redaction.ts` replaces Fastify's `req`, `res`, and
`err` serialisers. `req.url` is rewritten so `/<basePath>/api/foo` is logged as
`/<base>/api/foo`, with `<base>` as a fixed literal — never a truncated or hashed
form of the real value, which would still be a stable per-install identifier. The
path *after* the prefix survives, so the log stays useful. Fastify merges an
instance's own serialisers over its defaults (`fastify/lib/logger-pino.js`), which
is why setting them on the pino instance is what takes effect.

**Catch-all — the redacting destination.** `createRedactingDestination()` elides
the base path from every fully-serialised log line on its way to stdout, alongside
the credential-shape scrub. This is what covers everything a serialiser cannot:
the `request completed` line, an error message, a stack frame, a nested object
value, and any string a call site built by hand. Three spellings are matched —
the raw value, the JSON-escaped body of the value (`PANEL_BASE_PATH` is
operator-supplied and unvalidated, so it may contain a quote or a backslash), and
the percent-encoded value.

The match is on the bare base path rather than on `/<basePath>`, so it also
catches the value where it appears without a leading slash. The accepted cost is
that a very short operator-supplied `PANEL_BASE_PATH` will also elide unrelated
text from log lines; that is the right trade for a value that must not be printed,
and generated base paths are 22 characters.

The scrub covers the **logger**, not stdout in general. A `console.log` or a bare
`process.stdout.write` bypasses it — which is why the first-boot banner still
prints, and why the sentinel sweep below is the thing that keeps any other direct
write from creeping in.

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
express), `tests/integration/base-path.test.ts` (near-miss prefixes of
increasing accuracy all producing a byte-identical 404), and
`tests/integration/base-path-logging.test.ts` (the elider's four spellings, and
the request, response, error and hand-built log paths through a real server).

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

## Secrets

### Key derivation

`src/server/crypto.ts` holds the master key in a module-private binding. It is
never exported, never returned, and never used directly for encryption. Consumers
call `deriveSubkey(info)`, which runs HKDF-SHA256 over the master key with a
constant application salt and a purpose-specific `info` label, producing a
32-byte subkey. Labels live in `KeyPurpose`; a label is never reused for a second
purpose, so a bug in one subsystem cannot mint a ciphertext another subsystem
would accept.

The HKDF salt is a constant, which is correct here: the master key is already 32
bytes of CSPRNG output, so the salt has no low-entropy input material to spread,
and a constant keeps derivation reproducible across restarts.

### Encryption

AES-256-GCM, a fresh 96-bit nonce per write, 128-bit authentication tag. Payloads
are versioned and self-describing:

```
v1.<nonce>.<ciphertext>.<tag>     each part base64url
```

`decrypt()` rejects a version it does not recognise rather than guessing at the
layout, and rejects a wrong-length nonce or tag before attempting anything.

The AAD is `<table>:<rowId>:<column>`, built by `columnAad()`, which refuses parts
containing `:` so the encoding cannot be made ambiguous. Binding to the row and
column means an attacker with database write access cannot promote their own
secret into another row, or another column, by copying bytes — the tag will not
verify.

Every authentication failure raises the same opaque `DecryptionError` with the
same message. A wrong AAD, a flipped ciphertext bit, and a wrong master key are
indistinguishable to the caller.

### Secrets in memory

`SecretString` holds the value in a private field reachable only through
`.reveal()`, which makes every disclosure an explicit, greppable act. Every
implicit escape route is overridden to yield `[redacted]`: `toString`, `toJSON`
(which is what pino's serialisers go through), `Symbol.toPrimitive` (template
interpolation and `+`), and `util.inspect.custom` (`console.log` and nested
inspection). The object has no enumerable properties, so a spread or
`Object.entries` yields nothing.

`mask()` produces the display form — `sk-ant-…a1b2`. It reveals at most the last
four characters. A recognised credential prefix is kept, because it tells an
operator *which* credential they are looking at without disclosing any of it, and
is dropped when too little material follows it. Values shorter than eight
characters get a fixed placeholder.

### Logger redaction

`src/server/plugins/logger-redaction.ts` wraps the pino destination, so every
fully-serialised log line is scrubbed on its way to stdout: message strings,
nested object values, error stacks, and serialiser output alike, with no need to
know which key a secret ended up under. Recognised shapes are `sk-ant-`,
`github_pat_`, `ghp_`, `gho_`, generic `sk-`, and JWTs (anchored on the `eyJ` that
a base64url-encoded JWT header always begins with). Each is replaced with its
prefix plus `[redacted]`, so an operator can tell what kind of credential leaked
and go fix the call site. The same destination elides the secret base path — see
*Secret Base Path → Elision from logs*.

This is the **second** line of defence. It is pattern-based, so it can only catch
credentials whose shape it recognises — an opaque credential is invisible to it.
`SecretString` is the control; anything this layer catches is a bug worth fixing
at the source.

### Storage

`SecretsRepository` (`src/server/services/secrets.service.ts`) reads return
`SecretString`, never a raw string, so a value cannot reach a log line or a
response body by being passed along inattentively. `list()` returns metadata only.

A row that exists but will not decrypt throws rather than reporting the secret as
absent: that means a wrong master key or a tampered database, and answering
"absent" would invite the caller to overwrite a secret that is still good.

Migration `006_secrets_payload.sql` replaces the separate `ciphertext`/`nonce`
columns from `004` with a single `payload` column, because separate columns cannot
express the version prefix.

### Generic error responses

`app.setErrorHandler` in `src/server/app.ts` returns nothing but the status's
standard reason phrase. Fastify's default handler puts the thrown `Error`'s
message straight into the response body, which is how a credential inside an error
message — "upstream rejected sk-ant-…" — reaches the client verbatim. The sentinel
sweep below caught exactly that. The real error is still logged, through the
redacting destination.

### Tests

- `tests/unit/crypto.test.ts` — round trip; subkey determinism, per-label and
  per-master-key separation; AAD mismatch by row, column and table; single-byte
  alteration of the nonce, the ciphertext and the tag, each separately; wrong
  master key; nonce uniqueness across repeated encryptions; unknown version
  prefixes; malformed payloads; and that every authentication failure reports
  identically.
- `tests/unit/secret-string.test.ts` — each override asserted individually as
  well as through coercion (`Symbol.toPrimitive` shadows `toString` for every
  implicit path, so a leaking `toString` would otherwise be invisible), plus
  interpolation, `JSON.stringify`, `console.log`, `util.inspect`, enumerability,
  masking bounds, and the redaction rules.
- `tests/unit/secrets-repository.test.ts` — round trip through storage,
  ciphertext-only rows, in-place overwrite, rollback on a failed write, and
  transplanting a payload between rows and between columns.
- `tests/integration/secret-leak.test.ts` — the sentinel sweep.

### Sentinel sweep

`tests/integration/secret-leak.test.ts` seeds three unique sentinels and asserts
none of them ever appears where it should not:

- One patterned like a real Anthropic key, which both `SecretString` and the
  redaction layer should stop.
- One entirely opaque, which only `SecretString` can stop — which is the point of
  it being the primary control.
- **The configured base path.** Rule: it must never appear in stdout or stderr at
  all, and must not appear in any response body except the two that are served
  from under the prefix and cannot avoid it — the bootstrap script, whose whole
  purpose is to carry it, and the shell HTML that references the script by
  absolute path. Those two exemptions are an explicit allowlist in the test, and
  the test also asserts the exemption is not vacuous (the bootstrap body really
  does contain it), so an exemption cannot quietly grow to cover a genuine leak.
  Response *headers* are excluded from the base-path rule: the session cookie's
  `Path` attribute necessarily carries it.

It then exercises every route (asserting the route table against a literal, so
adding a route without extending the sweep fails the test) with both `GET` and
`HEAD`, feeding the sentinels back in as query, header and cookie input; drives
every log path, including an object, a nested object, an `Error`, and pino's error
serialiser, for both the credential sentinels and the base path; and captures
stdout, stderr, and `console` output. It asserts the credential sentinels appear
in no captured output, no response body, and **not in `panel.db`, `panel.db-wal`,
or `panel.db-shm` on disk** — at rest as well as in flight.

The suite has been mutation-checked: leaking `toString`, leaking `toJSON`, a
`mask()` that reveals twelve characters instead of four, an AAD that drops the row
id, a changed header value, an unexpected extra header, and a base-path elider
turned into the identity function each make it fail.

## Not Yet Implemented

These are listed so the map stays complete; each will be filled in with its
milestone.

- Password hashing (argon2id) and the constant-time dummy-hash path — M1.4.
- Server-side sessions, opaque tokens, SHA-256-at-rest — M1.4.
- TOTP and recovery codes — M1.4.
- CSRF double-submit token and strict `Origin` validation — M1.4.
- Progressive per-IP and per-account lockout — M1.4.
- Rate limiting and request size limits — M1.4.
- Audit log — M1.4.
