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

## The health endpoint

`src/server/routes/healthz.ts`. `GET /healthz` is the only route outside the secret
base path, and the only one Railway ever calls.

**What Railway does with it decides what it should assert.** Railway polls the
configured healthcheck path until it receives a 200 and *only then* makes the new
deployment live; it does not poll the endpoint afterwards. That makes the two failure
directions completely asymmetric:

- A `/healthz` that fails during boot costs a deployment. The previous deployment stays
  up, which is the correct outcome when the new one is broken. The cost is a red deploy.
- A `/healthz` that answers 200 before the panel can actually serve pushes a broken
  deployment live, and nothing checks again until a human does.

So it asserts **reachability plus a bounded read of the database**, not reachability
alone. Reachability by itself is already a fair signal here, because `buildServer` opens
the database and runs migrations *before* `listen()` — a container that accepts a
connection has necessarily got that far. But "the database opened once, at boot" is not
"the database is readable now", and the cases that separate them are exactly the ones a
volume-backed deployment meets: the mount detached, the disk filled, the file was
replaced by a restore under a different key.

The read is one prepared statement counting `schema_migrations`, compared with the
number of migration files this build shipped. That answers a second question for free —
*is the database fully migrated* — which matters because a half-migrated database serves
happily right up to the first query that touches the missing table.

What it deliberately does not do:

| | why |
| --- | --- |
| no write probe | it would catch a full disk, at the price of WAL churn on every poll forever; a health endpoint that mutates state is a bad trade |
| no detail in the body | success is exactly `{"ok":true}`, failure exactly `{"ok":false}` with a `503`; the reason goes to the log. The endpoint is unauthenticated and reachable by anyone who can reach the panel, and "6 of 8 migrations applied at /data/panel.db" is free reconnaissance |
| no version, uptime or build id | asserted absent by `tests/integration/healthz.test.ts` |
| no base path, no session | it is mounted outside the prefix precisely so a prober that has not been told the secret can reach it — and it is *not* reachable inside the prefix, which would put the secret into whatever configuration polls it |

It carries one header nothing else in the panel does: `Cache-Control: no-store`. A
response with no caching directive, no `ETag` and no `Last-Modified` is heuristically
cacheable, and "the health endpoint said fine" is the last answer that should ever come
out of a cache.

It is exempt from `Host` validation and from the rate limiter, and both exemptions are
the same argument: Docker's own `HEALTHCHECK` arrives as `localhost:8080` while the
public host is something else, so a 403 there — or a 429 — is a container-kill
primitive, three failed probes from stopping the container.

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
6. **The session cookie is actually in the jar.** In DevTools → Application →
   Cookies, confirm a cookie named `panel_session` exists after login in local
   development, and `__Secure-panel_session` in production. This is the check the
   test suite structurally cannot make: `inject()` reports the header the server
   sent, and the failure mode here is a browser silently declining a header that is
   correct on the wire.

   Two things will mislead an operator reading that panel:

   - **Cookies are not isolated by port.** Every application running on
     `127.0.0.1` shares one cookie jar regardless of port, so the list will contain
     cookies set by unrelated local development servers. Filter by name. A stale
     `panel_session` from another project on another port is also a real
     possibility — clear it rather than reasoning about it.
   - **`localhost` and `127.0.0.1` are different jars.** A cookie set while
     browsing `http://localhost:3000` is not sent to `http://127.0.0.1:3000`.
     Whichever host `PANEL_PUBLIC_URL` names is the one to browse; mixing them
     produces a login that appears to succeed and then 401s, which looks exactly
     like the `__Secure-` prefix bug and is not it.

7. **The CSRF cookie is readable by script, and the session cookie is not.** In the
   console, `document.cookie` must contain `panel_csrf` (or `__Secure-panel_csrf` in
   production) and must **not** contain `panel_session`. That asymmetry is the whole
   double-submit mechanism: the half the client has to echo is readable, the half that
   authenticates is not. The suite asserts the `HttpOnly` attribute on the wire; only a
   browser can confirm what script can actually see.
8. **A real fetch carries the header and succeeds.** From the console on the panel
   origin, a `fetch` to a mutating endpoint with `X-CSRF-Token` set from
   `document.cookie` must succeed, and the same `fetch` with the header omitted must
   return 403. This is `tests/integration/csrf.test.ts` repeated in the one environment
   the suite cannot reach — a document, a jar the browser manages, and `SameSite` in
   force.
9. **The WebSocket handshake is not blocked by CSP.** Phase 3, and the check that the
   `connect-src 'self'` note above is waiting on: open the terminal and confirm the
   socket connects with no CSP violation in the console. Also confirm the server-side
   `Origin` check on the handshake did not reject it — a rejected upgrade looks like a
   socket that closes immediately.
10. **429 shows a `Retry-After` the client honours.** Hammer a reload in local
    development against a shrunk bucket and confirm the response is a 429 with
    `Retry-After` in the Network tab. The suite asserts the header; a browser is the
    only place to see what the SPA does with it once M2 exists.
11. **The boot line and the cookie jar agree** (new in M1.6). After a deployment, read
    the `panel configuration resolved` line in the service log and note `publicOrigin`,
    `cookieProfile` and `sessionCookie`. Then log in and check DevTools → Application →
    Cookies. The cookie in the jar must have exactly the name that line printed. This is
    the one check that catches the whole `PANEL_PUBLIC_URL` failure class in one look:
    the server says "I issued `__Secure-panel_session`", and if the jar disagrees the
    browser declined it and the next request will be a 401 for a reason nothing in the
    console explains. The suite cannot make this comparison — it can assert the header the
    server sent and the log line it wrote, and neither is what a browser decided to keep.

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

### Key rotation

**There is no key-rotation procedure, and `PANEL_MASTER_KEY` must be treated as
permanent for the life of the database.** This is stated here rather than left to be
discovered, because the failure mode is quiet in one direction and alarming in the
other.

Three things are derived from that one key, and each reacts differently to being
given a new one:

| derived under | what a new key does |
| --- | --- |
| `KeyPurpose.SecretColumn` | every stored secret becomes permanently undecryptable — a `DecryptionError` at the moment something tries to read it, not at boot |
| `KeyPurpose.CsrfToken` | every issued CSRF token stops matching, so the next mutating request from an open browser tab is a `403`; harmless, and fixed by logging in again |
| `KeyPurpose.AuditChain` | **every historical audit row stops verifying at once**, and `verify()` reports `row_hash_mismatch` at the oldest surviving row on a log nobody has touched |

The third is the one that matters, because it is indistinguishable *in kind* from a
tamper and an operator who is shown a false alarm once will discount the real one.
`row_hash` is an HMAC over the row's contents under a subkey of the master key: a
new key invalidates all of them simultaneously. A tamper cannot look like that — the
attacker had to leave every row before the one they edited alone — so `verify()`
reports `hint: 'wrong_key_or_genesis'` for a break at the oldest surviving row and
nothing else. See [verify()](#verify).

The rotation that *would* be safe is therefore not "change the variable". It is:
decrypt every secret under the old key, re-encrypt under the new one, and re-chain
the audit log from its floor — the last of which destroys the property the chain
exists for, since a re-chained log is attested from the moment it was re-chained
and not from when its rows were written. `initChain()` does exactly that for rows
written before migration 008 and says so in the same terms. Nothing automates it,
and nothing should without the operator deciding that trade explicitly.

Practical consequences, all of which belong in the runbook and are in
`docs/DEPLOY.md`:

- Store the key where it will outlive the deployment, and separately from any
  database backup. Either one alone is useless: the backup without the key yields no
  readable secret and no verifiable log, and the key without the backup yields
  nothing at all.
- A backup restored under a different master key fails `verify()` with the
  `wrong_key_or_genesis` hint. That is the expected symptom, not a compromise.
- If the key is genuinely lost, the recovery is a new database: a fresh volume, a
  fresh seed from `PANEL_ADMIN_USERNAME`/`PANEL_ADMIN_PASSWORD`, and the loss of the
  audit history. Nothing in the panel can recover the old one, by construction.

### Encryption

AES-256-GCM, a fresh 96-bit nonce per write, 128-bit authentication tag. Payloads
are versioned and self-describing:

```
v1.<nonce>.<ciphertext>.<tag>     each part base64url
v2.<nonce>.<ciphertext>.<tag>     identical layout, different AAD scheme
```

`decrypt()` rejects a version it does not recognise rather than guessing at the
layout, and rejects a wrong-length nonce or tag before attempting anything.

The AAD is `<table>:<rowId>:<column>`, built by `columnAad()`, which refuses parts
containing `:` so the encoding cannot be made ambiguous. Binding to the row and
column means an attacker with database write access cannot promote their own
secret into another row, or another column, by copying bytes — the tag will not
verify.

**The version selects the AAD scheme, not the cipher.** `v1` and `v2` differ in
nothing but what the tag commits to: `secrets:<rowId>:payload` against
`secrets:<scope>:<name>`. Same cipher, same layout, same nonce and tag lengths. That
is what the version prefix was put on the format for in M1.3 — the alternative is
inferring the scheme from the row, and the row is the part an attacker with database
write access can edit. *Storage*, below, is why the second scheme exists.

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

**`mask()` is the wrong display for a short or low-entropy identifier**, and M1.7 is
where that first bit. Last-four of a nine-digit Telegram chat id discloses most of
it, and there is no prefix worth keeping. So the Telegram configuration is reported
as **set/unset plus a character count** — the form `npm run preflight` already uses
for every credential, which catches a truncated paste and a variable that never
arrived while displaying none of the value. `mask()` remains the display for the
credentials it was written for, which are long and prefixed.

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

#### Payload version `v2`: the AAD binds the row's logical identity, not its id

M1.7 puts the Telegram bot token and chat id in this table, and the row-id AAD is the
wrong binding for them. `secrets:<rowId>:payload` stops a ciphertext being moved
between rows; it says nothing about that row's `scope` and `name`, so an attacker with
write access to `panel.db` can **relabel** a row and the ciphertext still
authenticates. Applied to these two values that is not theoretical: swap the
`bot_token` and `chat_id` labels and the panel puts the bot token into the `chat_id`
query parameter of a request to `api.telegram.org`. Telegram rejects the call, and the
token has still left the process.

`UNIQUE (scope, name)` from migration 006 makes the fix free — at most one row can
hold a given pair, so `secrets:<scope>:<name>` is at least as strong as the row-id
form and strictly stronger against relabelling. New writes are `v2`; a stored `v1`
payload keeps decrypting under the old scheme, selected from the stored prefix rather
than guessed.

**Injectivity comes for free from a check `columnAad()` already had.** It refuses a `:`
in its *table* and *column* arguments, and `name` is passed as the column — so
`('project:7', 'x')` yields `secrets:project:7:x` while `('project', '7:x')` is refused
outright rather than colliding with it. A `scope` **may** contain colons, which it must,
because project-scoped secrets are spelled `project:<uuid>` (`PORTABILITY.md` §4.1):
with `name` colon-free the last colon always separates the pair. A unit test asserts the
collision is rejected rather than merely unlikely. An AAD is only ever compared
byte-for-byte, never parsed, so injectivity is the entire requirement.

`upgradeLegacyPayloads()` re-encrypts any `v1` row as `v2` at boot, once, and reports
how many it moved. **In code, not in a migration**, for two reasons: a SQL migration
cannot re-encrypt anything, and a migration step that threw — wrong master key,
tampered row — would make the panel unbootable rather than merely leaving a legacy row
in place. The cost is stated rather than hidden: a **downgrade** to a build older than
M1.7 cannot read a row this has upgraded, because that build's accepted-version list
has no `v2` in it. Restoring a pre-M1.7 backup is the escape hatch, which is one more
reason `npm run backup` exists.

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

A second sweep covers the M1.4 credentials, and uses the *real* values the running
server generated rather than planted sentinels — a sweep against a value we planted
only proves the plumbing we planted it through. Each has one legitimate exit and no
others:

| Credential | May appear in | Must not appear in |
| --- | --- | --- |
| Session token | the `Set-Cookie` **header** | any response body, any log line, the database (only `sha256` of it) |
| TOTP secret | the enrolment response body, once | every other body, any log line, the database (only the AES-GCM payload) |
| Recovery codes | the enrolment-confirmation and regeneration bodies, once | every other body, any log line, the database (only argon2 hashes), in either the displayed or canonical spelling |

The counterpart test asserts those disclosures really do happen, so the exemptions
cannot pass by the secrets never being produced at all.

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

## Authentication

### No per-IP anything, and no lockout

**Operator decision, and the single most load-bearing design choice in this
milestone: nothing in the authentication path branches on the client IP address,
and nothing locks out.**

The reasoning is not that per-IP throttling is useless in general — it is that it
is worse than useless *here*:

- The operator reaches this panel through tunnels with rotating addresses. Per-IP
  throttling would inconvenience the one legitimate user on a schedule they cannot
  predict.
- An attacker rotates addresses for free. Per-IP throttling would cost them
  nothing.
- An account lockout on a single-user panel is a denial-of-service primitive
  handed to anyone who can reach the login endpoint. There is no second
  administrator to unlock it.
- With `PANEL_TRUST_PROXY` on (the Railway default) the address comes from
  `X-Forwarded-For`, which the client sets. A security decision made from it is a
  security decision made from attacker-supplied input.

The address is still *recorded*, on the session row and on the audit row, because
the operator needs to recognise their own sessions. `src/server/utils/client-ip.ts`
is the single place it is read, and that is enforced rather than asserted:
`tests/integration/no-ip-decisions.test.ts` scans every file under `src/server`
for `req.ip`, `req.ips`, `remoteAddress`, `socket.remote*` and `x-forwarded-for`,
and fails if any file outside that one and the log serialiser touches them. It also
proves the property behaviourally — four failures from four different addresses
raise one shared counter, and the fourth is already delayed — and asserts the
`lockouts` table from migration 005 is gone and `auth_failures` has no `scope` or
`ip` column to key on.

Migration 005 is left exactly as written; `007_auth.sql` drops the table. A
migration that has already run somewhere is never edited in place.

### Progressive delay

`src/server/services/auth-delay.service.ts`. One persisted counter of consecutive
failed authentication attempts, keyed on nothing at all — which is precisely why
changing address, changing username, or restarting the process does not clear it.

| consecutive failure | target total response time |
| --- | --- |
| 1, 2, 3 | none — argon2id already costs ~250 ms, and a typo should not be punished |
| 4 | 500 ms |
| 5 → 9 | 1 s, 2 s, 4 s, 8 s, 16 s |
| 10 and beyond | 30 s (hard cap) |

The cap is not arbitrary. Past roughly half a minute, proxy and client read
timeouts start firing, and a client that has given up does not stay queued behind
the single-flight gate — so a longer delay would *reduce* the cost of an attempt.

Four properties, each of which the mechanism is worthless without:

**It is a target total time, not work plus sleep.** `pad()` measures from the
start of the attempt and sleeps only the remainder. argon2's own variance —
which differs measurably between the real-hash and dummy-hash paths on a loaded
machine — is absorbed into the target rather than added on top of it. Observed on
a real boot: a 16 s target with argon2 taking 188 ms slept 15,812 ms.

**A success is delayed exactly as much as a failure.** The target is priced from
the counter as it stands on arrival, as though the attempt were about to fail. A
failure takes the counter to *n+1* and lands on that target; a success resets the
counter to zero and lands on the *same* target. Price it from the post-outcome
counter and a correct password becomes the one guess that comes back fast — a
cleaner oracle than the one the delay was added to close.

**The counter resets only on a complete login.** Password *and* second factor. A
correct password followed by a wrong code leaves it higher than it started, so the
expensive half of a guess cannot be spent clearing the cheap half's accumulated
cost. `AuthDelayService.reset()` has exactly three call sites: the second-factor
step, enrolment confirmation, and step-up — all of which require both factors.

**Attempts do not overlap.** `src/server/utils/single-flight.ts` admits one
running attempt plus one queued; a third concurrent attempt gets 429 before any
credential is looked at, so the rejection reveals nothing. Without this, a
thousand parallel requests all serve the same delay simultaneously and a thousand
guesses cost one delay period.

Where the clock starts is a deliberate departure from "measure from request
receipt", because the two requirements conflict: if a queued attempt's target were
measured from its arrival, the time it spent waiting for the gate would count
towards its own target, it would need no padding, and N parallel attempts would
again cost one period. The clock therefore starts when the attempt acquires the
gate. The reason "measure from receipt" existed — a total time that absorbs
argon2's variance — is preserved in full.

The clock and the sleep function are injected (`src/server/utils/clock.ts`), so the
suite asserts the computed target rather than wall-clock elapsed time. A suite that
actually slept would take minutes and would be flaky on a loaded machine.

### Password hashing and the username oracle

`src/server/services/user.service.ts`. argon2id, 64 MiB, t=3, p=1 (OWASP's second
recommended configuration; `p=1` because the container has one meaningful core).
The parameters are recorded in the encoded hash, so raising them later is a
re-hash on next login, not a migration.

`verifyCredentials()` performs a **full** argon2 verification on every call. When
the submitted username does not match, it verifies against a dummy hash computed
at boot from a discarded random string. Without that, an unknown username returns
in microseconds and a known one in a quarter of a second, which is a username
oracle readable over the network with no statistics at all. The dummy path
increments a counter that `tests/integration/auth.test.ts` asserts on, so the
branch is *proven* taken rather than inferred from the response looking the same.

The username itself is compared with `timingSafeEqualStrings`, so it cannot be
walked a character at a time. Its length leaks, which is unavoidable and
irrelevant — the username is not the secret.

Recovery codes use lighter argon2id parameters (19 MiB, t=2), and that is a
considered choice: a recovery code is 50 bits of CSPRNG output, so there is no
dictionary to run and the memory-hard parameter buys nothing, while ten sequential
64 MiB hashes on the one flow an operator uses when already locked out would cost
seconds.

### TOTP

`src/server/services/totp.service.ts`. RFC 6238, HMAC-SHA1, 6 digits, 30-second
step, ±1 step of accepted drift. `tests/unit/totp.test.ts` pins the RFC 6238
Appendix B SHA-1 reference vectors, which is what catches a wrong period or a
wrong truncation — a round trip against our own generator would agree with itself
whatever those were set to.

The secret is 160 bits from `node:crypto.randomBytes`, base32-encoded, stored
encrypted with the M1.3 module under AAD `users:1:totp_secret`. Enrolment leaves
`totp_enabled` at 0 until a code generated from the new secret comes back, which is
what proves the operator's authenticator actually holds it.

**Replay protection** is the piece most often left out and the one that matters
most here. A code is valid for a whole step plus drift, so without it a code seen
over a shoulder, in a screenshot, or from a compromised authenticator is replayable
for up to ninety seconds. The last accepted step number is persisted and every new
code must come from a **strictly greater** step, so a code accepted once is dead
even inside its own window — and stays dead across a restart. A rejection that
would have matched but for the replay bound is audited as `replayed_totp_code`
rather than as a bad code, because the two mean different things to an operator.

Once `totp_enabled` is 1, a password alone can never produce a usable session.

### Recovery codes

Ten codes, shown exactly once at enrolment, stored only as argon2id hashes.
Format `ABCDE-FGHJK` from a 32-symbol alphabet (digits 2–9 plus the alphabet
without `I` and `O`) — 50 bits, with no `0`/`O` or `1`/`I` pair to mistype off a
printout. Exactly 32 symbols so a byte masked to five bits selects without bias.

`consume()` verifies every unused code without short-circuiting on the match, so
elapsed time does not reveal how far down the list the code sat. Marking used and
recounting happen in one transaction, so a crash cannot leave a code spent but
still counted, or counted but still spendable. Regeneration invalidates the whole
previous set, used or not.

### Sessions

`src/server/services/session.service.ts`. Opaque 256-bit tokens from
`randomBytes`, stored as `sha256(token)` — the plaintext exists in the cookie and
nowhere else, ever. Not JWTs: revocation has to take effect on the next request,
with no window in which a signed-but-revoked token is still honoured.

`resolve()` scans every session row and compares each stored hash with
`timingSafeEqual` rather than letting SQLite match on an indexed `=`. There are at
most a handful of rows for a single user, so the scan is free, and it means no
comparison against a stored credential anywhere in this codebase short-circuits on
the first differing byte. The loop deliberately does not break early.

| Property | Value |
| --- | --- |
| Cookie name | `__Secure-panel_session` over https; `panel_session` over loopback http |
| Attributes | `HttpOnly; SameSite=Strict; Path=/${basePath}`, plus `Secure` over https, **no `Domain`** |
| Max-Age | the sliding idle window, clamped to what is left of the absolute deadline |
| Idle timeout | 8 hours, sliding on use, clamped to the absolute deadline |
| Absolute lifetime | 30 days from the moment both factors were satisfied |
| Pre-auth lifetime | 5 minutes, not sliding |
| Step-up window | 5 minutes, on that one session |

`Domain` is omitted rather than set to the exact host: setting it at all widens the
cookie to every subdomain.

#### One owner for every cookie

`src/server/plugins/cookies.ts` is the only file in `src/server` that names a
cookie or assembles an attribute set, and
`tests/integration/cookie-discipline.test.ts` enforces that by scanning every
source file for a name literal, a prefix, a `setCookie`/`clearCookie` call, a
direct `req.cookies` read, or an attribute name — the same static-scan mechanism as
the client-IP rule. The scan also asserts its own patterns still match the shapes
they are meant to catch, so a typo cannot quietly make it vacuous.

The rule exists because of what it replaced. The name was a constant in
`services/session.service.ts` and the attributes were a helper in
`plugins/auth.ts` that hard-coded `secure: true`; one decision spread across two
files, and the consequence below went unnoticed because no single place owned it.

#### Two profiles, and why the `__Secure-` prefix could not be unconditional

The `Secure` **attribute** and the `__Secure-` **name prefix** are separate
mechanisms and browsers do not treat them alike over loopback. Chrome accepts a
`Secure` cookie on `http://127.0.0.1` — loopback is a potentially-trustworthy
origin — but it does not extend that concession to the name prefix, whose rule is
unconditionally "must arrive over a secure scheme". The cookie is therefore
dropped, silently: the `Set-Cookie` header is present and correct, no console
warning appears, and the cookie simply never enters the jar. Firefox accepts it;
Safari rejects both. The consequence was that over plain http in Chrome, login
could never succeed — the panel would 401 every request after a successful password
and TOTP step — which would have blocked client development in M2 outright. The
server's header was never wrong; the *name* was unusable.

So there are two profiles, chosen by `cookieProfileFor()` from the effective public
origin:

| Public origin | Name | `Secure` | Rest |
| --- | --- | --- | --- |
| `https://…` | `__Secure-` prefixed | yes | `HttpOnly`, `SameSite=Strict`, `Path=/${basePath}` |
| `http://` loopback, non-production | unprefixed | no | unchanged |
| `http://` anything else | *refuses to start* | — | — |

The weak profile cannot leak into production, and there are deliberately **two
independent guards** so that removing either one still fails a test:

1. `resolvePublicOrigin()` throws at boot when `NODE_ENV=production` and the
   resolved origin is not https, and when no origin is configured in production at
   all. Refusing to start beats shipping a cookie the browser will drop.
2. `cookieProfileFor()` throws rather than returning the weak profile when
   `NODE_ENV=production`, or when the origin is http on a non-loopback host at any
   `NODE_ENV` — "http and routable" is precisely the case where dropping `Secure`
   hands the cookie to anyone on the path.

`tests/integration/cookies.test.ts` covers both directions, and each guard was
mutation-checked by disabling it and confirming a distinct test fails.

#### Why not `__Host-`

`__Host-` is the stronger prefix: host-only, no `Domain` permitted, and proof
against a sibling subdomain writing the cookie into the parent's jar. It also
mandates `Path=/`. This cookie is scoped to `Path=/${basePath}` so that it is not
attached to requests outside the secret prefix — including `/healthz`, the one
route an unauthenticated caller is meant to reach. Widening the path to `/` to gain
the prefix would send the session cookie on every request to the origin, which
trades a real reduction in exposure for a guarantee against an attack (subdomain
cookie-shadowing) that a single-host deployment with no sibling subdomains does not
face. The prefix is therefore deliberately not used, and the path scoping is the
control kept instead.

#### Cookie lifetime, decided rather than omitted

`Max-Age` mirrors the sliding idle window — 8 hours for a `full` session, 5 minutes
for a `pre` one — and is clamped to what is left of the absolute deadline, so a
session with ten minutes of absolute lifetime left never hands out an eight-hour
cookie. It is re-stamped on every authenticated response by an `onSend` hook in the
API scope, matching the server-side slide that `resolve()` just performed;
`refreshSession()` declines to act when the response already carries a session
`Set-Cookie`, so a rotation or a logout is never overwritten with the value it just
replaced.

The alternative was to omit the attribute entirely, which produces a "session
cookie". That reads as "gone when the browser closes" and is not: Chrome's session
restore, and Firefox's, put session cookies back after a restart, so omitting the
attribute is a guarantee about nothing. The server-side row remains the only
authority on the lifetime — it is the bound an attacker holding a stolen cookie
cannot extend — but a client that discards its copy on schedule is one fewer copy
sitting on disk. `tests/integration/cookies.test.ts` asserts the clamp, including
that `Max-Age` never exceeds the 30-day absolute limit.

The CSRF cookie is issued from the same call, with the same attributes except
`HttpOnly` — a double-submit token the client must read to echo back. Because both
are set together, the CSRF token cannot outlive the session token it is bound to.

The token rotates on every privilege change — the second factor being accepted, and
a password change. The row keeps its identity across a rotation so the session list
and revoke-others stay coherent, but the old cookie value stops working the instant
the rotation returns. Promotion to `full` restarts the absolute lifetime and drops
any step-up.

A session past either deadline is deleted when it is next presented, not merely
rejected, so the table does not accumulate dead rows waiting for a sweeper that
would then be the only thing keeping this honest.

### Two-stage login and the pre-auth session

`POST /api/auth/login` verifies the password and issues a five-minute session at
`authLevel: 'pre'`. That level can reach the second-factor endpoint, the enrolment
endpoints, `me`, and logout — and nothing else. Everything else answers 401. It
exists because first-run enrolment has to be reachable before there is any full
session to be had, and because handing out a cookie between the two steps of a
login needs the cookie to be worth almost nothing.

`POST /api/auth/login/totp` accepts a six-digit TOTP code or a recovery code
(dispatched on shape), rotates the token, promotes the row to `full`, and is the
only place the failure counter resets.

### Step-up re-authentication

Password **plus** a fresh second-factor code, valid five minutes, on that session
only. This is what makes a stolen session cookie a bounded loss: it can read the
panel, but it cannot change the password, read a stored credential, disable the
second factor, regenerate the base path, or reissue recovery codes.

`requireStepUp` answers 403 rather than 401, and that is not a leak — the caller
already holds a valid session and already knows whether it has stepped up. A
password change spends the step-up as well as rotating the token, so one step-up
does not authorise an unbounded chain of privileged actions.

### CSRF: three controls, and what each one actually covers

`SameSite=Strict` on both cookies is the primary control: no cross-site request of
any method carries them.

`src/server/plugins/origin-check.ts` is the second layer — see the next section,
which is where it changed substantially in M1.5. It covers what `SameSite` does not:
a same-site-but-different-origin document (`http` versus `https`, another port), and
browsers predating current SameSite semantics.

`src/server/plugins/csrf.ts` with `src/server/services/csrf.service.ts` is the third,
and it is **no longer deferred**. It was deferred through M1.4 with the reason that it
needs a header a client sets and there was no client; M1.5 built it anyway, because
the mechanism is testable without one — `tests/integration/csrf.test.ts` drives it
with real `curl` and a real cookie jar — and shipping it now means the M2 client is
written against a server that already requires it, rather than having the requirement
retrofitted around client code that works without it.

#### Derived, not random

```
csrfTokenFor(sessionId, sha256(sessionToken))
  = HMAC-SHA256( deriveSubkey(KeyPurpose.CsrfToken), `${sessionId}:${hash}` )  → base64url
```

The textbook double-submit token is a random value written to a readable cookie and
compared against a header. What that proves is only that whoever set the cookie also
set the header — and an attacker who can write a cookie for this host can do exactly
that. Cookie-writing is a weaker capability than same-origin script execution: a
sibling subdomain, an XSS anywhere on the eTLD+1, or a MITM on any `http` origin
sharing the registrable domain all suffice, and none of them can read this panel's
responses. A bare double-submit hands that attacker a working CSRF token.

So the value is derived under an HKDF subkey from the M1.3 crypto module — its own
`info` label, so it is not the key any secret column is encrypted under — and bound to
two things:

- the session **row id**, so a token minted for one session is rejected on another;
- the SHA-256 hash of that session's **current** token, so the CSRF token dies the
  moment the session token rotates: second factor accepted, pre→full promotion,
  password change. There is no rotation bookkeeping to forget, because there is no
  stored token to rotate. The expected value is recomputed on every request from the
  session cookie the client just presented.

#### What the hook requires

On `POST`, `PUT`, `PATCH` or `DELETE` with a live session, three values must agree:
the non-`HttpOnly` `…panel_csrf` cookie, the `X-CSRF-Token` header, and the value
derived from the session cookie presented. Both comparisons run through
`timingSafeEqualStrings`, because both compare client-supplied input against a secret.

The third leg is the one a bare double-submit cannot have. An attacker who writes both
halves produces a cookie and a header that match each other perfectly — and still
fails, because they cannot match the session cookie being presented.
`tests/integration/csrf.test.ts` tests exactly that case with two concurrently valid
logins, not merely a mismatched pair.

#### What it deliberately does not police

- **Safe methods.** `GET`, `HEAD` and `OPTIONS` change nothing.
- **Requests with no live session.** Login has no session to bind a token to, and
  there is nothing to protect: `SameSite=Strict` plus the `Origin` check stop a
  cross-site login attempt, and with exactly one account a forced login into "the
  attacker's account" is not a thing that exists here. The moment stage one succeeds
  the response carries both cookies, so stage two is covered.
- **A cookie that resolves to nothing.** That is not a session, so the hook passes it
  through and the route's own guard answers **401**, not 403. The distinction is
  deliberate: a 403 would tell an attacker their forged cookie was at least recognised
  as one.

The cookie half is written by `plugins/cookies.ts` in the same call that writes the
session cookie, so the two cannot drift — every path that issues or rotates a session
issues a matching CSRF token, and no route spells either cookie's name. That is
enforced by the static scan in `tests/integration/cookie-discipline.test.ts`.

### Origin and Host validation

`src/server/plugins/origin-check.ts`, rewritten in M1.5. The previous implementation
compared `Origin` against `` `${req.protocol}://${req.host}` ``. That is circular, and
worth naming plainly: an attacker who can make a browser send `Host: evil.example`
and `Origin: https://evil.example` satisfies it trivially, and every absolute URL the
application builds from `Host` — a redirect, a link in a future notification — points
at the attacker's host.

**The expected origin is now never derived from the request.** It comes from
`src/server/utils/public-origin.ts`, resolved exactly once at boot in this order:

1. `PANEL_PUBLIC_URL`,
2. `RAILWAY_PUBLIC_DOMAIN` (Railway injects it, and it always implies https),
3. a loopback development fallback at `PORT`.

That single resolved `PublicOrigin` is read by both the cookie profile
(`plugins/cookies.ts`) and this validator, so the two cannot disagree about what this
panel is — the dependency between `PANEL_PUBLIC_URL` and the cookie prefix is one
value in one file, not a convention. Two outcomes are fatal at boot rather than
degraded at runtime: production with no configured public URL, and production with a
non-https one. Both would otherwise surface as a cookie the browser quietly refuses,
or one sent in the clear.

The rules:

- **`Host` is checked on every method**, not just mutating ones, because Host
  poisoning is not a mutation-only problem. Outside production any loopback authority
  is accepted — `localhost:3000`, `127.0.0.1:3000` and `[::1]:3000` all work with no
  configuration; in production the match is exact.
- **`Origin` is checked on mutating methods and on a WebSocket handshake.** The
  handshake is matched on the `Upgrade` header, not the method, because a handshake is
  a `GET` and a method test alone would wave through the most state-changing request
  this panel will ever serve. Browsers send `Origin` on every handshake, so there is a
  value to check; what was missing was a reason to check it.
- An **absent** `Origin` is allowed. Browsers attach it to every cross-origin request
  and every same-origin mutating request, so absent means a non-browser client, which
  by definition is not being tricked into acting for someone else. A **present and
  wrong** one — including the literal `null` an opaque origin sends — is a 403.
- Outside production any loopback `Origin` is accepted, which is what lets a Vite dev
  server on `:5173` talk to the API on `:3000` in M2.
- `X-Forwarded-Host` and `X-Forwarded-Proto` are honoured **only** when
  `PANEL_TRUST_PROXY` is on, and **only their rightmost value**. `X-Forwarded-*`
  accumulates left to right, so the rightmost element is the one written by the proxy
  we are actually talking to and the only one that is not attacker-supplied. A
  forwarded request that admits it arrived over plaintext while the public origin is
  https is a `scheme_downgrade` 403: the TLS terminator was bypassed.
- A **duplicated** `Host` or `Origin` header arrives as an array in Node's parse and is
  refused rather than guessed at.
- `/healthz` is exempt from the `Host` check. Docker's `HEALTHCHECK` reaches the
  container as `localhost:3000` while production's public host is something else, and a
  health probe that 403s is a container-kill primitive — three failures stop the
  container.
- The verdict (`host_missing`, `host_mismatch`, `origin_mismatch`, `scheme_downgrade`)
  is logged and never sent. The client gets the bare reason phrase from
  `app.setErrorHandler`.

**Phase 3 obligation.** `validateRequestOrigin(policy, input)` is exported and takes an
`OriginCheckInput` shaped like a raw `http.IncomingMessage` rather than a
`FastifyRequest`, specifically so the terminal WebSocket handler can call it. A socket
upgrade arriving as a raw HTTP upgrade never becomes a Fastify request, so no
`onRequest` hook will ever see it — and it is cookie-authenticated and the most
state-changing operation in the panel. **The upgrade handler must call it itself.**

#### `PANEL_TRUST_PROXY` must be **on** behind Railway, and why that is not obvious

Both settings work. That is the trap: a first deployment with `PANEL_TRUST_PROXY=false`
serves, logs in, and passes any test that only asks "does it work?", because Railway's
edge sets `Host` to the real public domain as well as `X-Forwarded-Host`. So the
recommendation needs a reason attached, and there are three.
`tests/integration/railway-edge.test.ts` drives both settings against the edge's exact
header set and asserts each of them.

1. **With it off, the scheme-downgrade check is silently gone.** `X-Forwarded-Proto` is
   not read at all, so a request that arrived over plaintext — the TLS terminator
   bypassed, the container port reached directly — is indistinguishable from one that
   did not. With it on, the same request is a `scheme_downgrade` 403.
2. **With it off, the recorded client address is the container network's**, so every
   session row and every audit row shows the proxy rather than the client. Nothing
   *decides* from that value (the M1.4 rule, enforced statically by
   `no-ip-decisions.test.ts`) — but it is the only thing that lets the operator tell
   their own session from a stranger's in the session list.
3. **With it off, `Host` becomes the only input**, so anything ever placed in front of
   Railway that does not rewrite `Host` breaks the panel outright, and the failure is a
   403 on every request.

And the reason leaving it on is safe rather than a concession: only the **rightmost**
value of each `X-Forwarded-*` header is honoured — the one written by the hop we are
actually talking to — and the expected origin is never derived from the request in the
first place. The verified behaviour of Railway's edge is that it *overwrites* a
client-supplied `X-Forwarded-Host` with the real domain, so in practice there is one
value; the appended shape is tested anyway, in both orders, because that is someone
else's software and the panel should not depend on it.

#### The absent `Origin` is admitted, and — new in M1.6 — recorded

The third rule above is the one that most deserves a second look, and it survived it.
An absent `Origin` on a mutating request is still admitted, because the reasoning is
sound: a browser attaches `Origin` to every mutating request and every WebSocket
handshake, so an absent header means a client that is not a browser and therefore not
being tricked into acting for someone else. Rejecting it would break `curl`, the
panel's own test suite, and any future scripted use, in exchange for nothing.

What was wrong with it was that it was **silent**. In production this should never
happen — every request that matters comes from a browser — and an event that should
never happen is exactly the kind that must not pass unrecorded. So
`createOriginAbsenceAuditor` in `plugins/origin-check.ts` writes an
`origin.absent_admitted` audit row carrying the request's path and method, and
nothing else.

Two narrowings, each of which is the difference between a signal and a liability:

- **Only when a session cookie is present.** The observer runs in the root
  `onRequest` hook, which is *before* the base-path 404 sink answers and *before* the
  rate limiter charges anything. Writing a row for every anonymous `POST` would hand
  a scripted scanner a way to push real history out of a log with a retention cap.
  Presence is tested through the cookie jar and costs nothing; testing for a *live*
  session would mean resolving the token at root scope on every request, which is the
  database read `attachSession` pays for only inside `/api`.
- **Throttled to one row per fifteen minutes, carrying the count it suppressed.**
  The narrowing above still leaves someone who has learned the base path able to send
  a garbage cookie. Since the event means "a thing that should never happen
  happened", one row per window carries all of that information and `suppressed`
  carries the rest. The window is per process, so a restart re-arms it — erring
  toward recording.

The cookie is only ever tested for presence. Its value is not read, not logged, and
not in the row; `tests/integration/origin-absence.test.ts` asserts that the stored
metadata contains neither the token, nor its first eight characters, nor even the
cookie's name.

The predicate the observer uses (`isOriginAbsentOnStateChange`) and the branch the
validator takes are the **same** exported helper, `isStateChanging`. That is
deliberate: two independent copies of "does this request change state" would let the
audit row come to describe a different set of requests than the check it is observing.

### Rate limiting and request size

Still **no per-IP bucket** — that is the operator decision above, and it stands. M1.5
added rate limiting keyed on things an attacker cannot rotate:
`src/server/utils/token-bucket.ts` is the mechanism, `src/server/plugins/rate-limit.ts`
the policy.

- **One shared anonymous bucket** — 60 tokens, one back per second — charged for every
  request with no live session. Shared on purpose: the only unauthenticated surface is
  the shell, `bootstrap.js` and the login endpoints, so a legitimate client draws on it
  a handful of times and then stops touching it entirely.
- **One bucket per session row** — 120 tokens, four back per second — so a busy
  operator is never throttled by a stranger's flood and vice versa. Keyed on the
  **resolved** session id, never on a raw cookie value: keying on unvalidated input
  would let an attacker mint a fresh bucket per request by sending fresh garbage.

Two buckets rather than one, because either alone is a hole. A single global bucket
lets an anonymous flood empty it and 429 the operator — a denial of service handed to
anyone who can reach the panel. A purely per-session bucket cannot limit
unauthenticated traffic at all, because an unauthenticated request has no identity to
key on that the client cannot simply discard.

Over the limit is `429` with `Retry-After` in whole seconds, ceilinged and never `0` —
`Retry-After: 0` invites an immediate retry guaranteed to fail again. Buckets that have
refilled to capacity are evicted, since a full bucket is indistinguishable from a new
one, which bounds the map by sessions active within one refill window rather than by
sessions that have ever existed. The clock is injected, as everywhere else, so the
suite proves a refill without waiting for one.

#### How the bucket and the progressive delay interact

**The four `runAuthAttempt` endpoints are exempt from the buckets** —
`DELAYED_AUTH_PATHS`: `/api/auth/login`, `/api/auth/login/totp`,
`/api/auth/totp/enroll/verify`, `/api/auth/step-up`. This is a decision, not an
oversight. They already carry two stronger controls: the progressive delay, which
prices guess *n* at up to thirty seconds, and single-flight execution, which admits one
attempt at a time and 429s the third concurrent one. Stacking a bucket on top would add
nothing an attacker notices, because the delay is the binding constraint long before
sixty tokens run out — while handing anyone who can reach the login endpoint a way to
spend the operator's own tokens and lock them out of their own panel. That is the
lockout-as-DoS shape the no-lockout decision exists to avoid, arriving through a
different door.

`tests/integration/rate-limit.test.ts` asserts that the exempt set has exactly as many
members as `src/server/routes/auth.ts` has `runAuthAttempt(` call sites, so a fifth
delayed endpoint cannot be added without either listing it or failing the suite.

Also exempt: `/healthz`, for the container-kill reason above, and the out-of-prefix 404
sink — the base-path gate collapses every miss onto one constant URL before routing and
the handler writes a fixed body, so a bucket there would let a stranger's scan spend
tokens that matter.

#### Size and receipt-time bounds

Both on the Fastify instance in `src/server/app.ts`, both IP-independent:

- `bodyLimit` = 64 KiB (`BODY_LIMIT_BYTES`), plus per-field maxima in
  `src/server/utils/zod-schemas.ts`. The field bounds stop a megabyte of "password"
  reaching argon2; the body limit stops one reaching the JSON parser.
- `requestTimeout` = 30 s (`REQUEST_TIMEOUT_MS`). This bounds **receipt** of the
  request — headers and body — not the handler, and that distinction is what makes it
  safe to set at all: the progressive delay pads a failed login by up to thirty seconds
  *inside* the handler, and a timeout counting handler time would cut every slow-path
  login off at the knees. It closes the slow-loris shape where a socket dribbles a byte
  a minute and holds a connection open for free.

A note on the login password schema, unchanged: it has a maximum but **no minimum
length**. Rejecting a short password at the schema would return instantly, skipping both
the argon2 verification and the delay — a length oracle, and a free attempt. Login
accepts any non-empty password and lets it fail the hash comparison like any other wrong
one. The minimum applies where it belongs, on *setting* a password.

### A password change revokes every other session

`src/server/routes/security.ts`. `POST /api/security/password` requires a step-up, then
rotates the caller's token **and** calls `sessions.revokeOthers(rotatedId)`, answers
`{ok: true, revokedSessions: n}`, and writes a `session.revoked` row with
`reason: 'password_changed'` alongside the `password.changed` row.

The only reason to change a password is fear that it leaked. Rotating just the caller's
token would leave whoever the operator is afraid of holding a live session that the new
password does nothing about — and server-side opaque sessions exist precisely so
revocation lands on the very next request. `tests/integration/sessions.test.ts` proves
it with three live sessions: after the change, the two others 401 on `/api/auth/me` and
`sessionCount()` is 1.

### Audit log

`src/server/services/audit.service.ts`, with migration
`src/server/migrations/008_audit_integrity.sql` and the read routes in
`src/server/routes/audit.ts`.

Events: `setup.completed`, `two_factor.enrollment_started`, `login.success`,
`login.failure`, `totp.failure`, `recovery_code.used`, `auth.delay_applied`,
`session.created`, `session.revoked`, `password.changed`, `stepup.granted`,
`two_factor.disabled`, `recovery_codes.regenerated`, `secret.revealed`,
`secret.changed`, `base_path.regenerated`, `audit.trimmed` (M1.5), and — new in
M1.6 — `origin.absent_admitted`, which is described where the behaviour it observes
is, under
[The absent `Origin` is admitted, and — new in M1.6 — recorded](#the-absent-origin-is-admitted-and--new-in-m16--recorded).

A failure row carries the reason **category** only — `bad_credentials`,
`bad_totp_code`, `bad_recovery_code`, `replayed_totp_code`, `no_pending_login`,
`two_factor_not_enrolled` — never the attempted username, never the attempted
password, never the code.

Metadata is validated on the way in, and the validation **throws** rather than
scrubbing and continuing: a `SecretString`, a non-primitive value, or anything
matching the credential-shape patterns is rejected outright with `AuditMetaError`.
Metadata is built from fixed shapes by this application's own code, so a violation
is a programming error, and the append-only audit log is not the place to discover
months later that a credential has been sitting in it. String values also have the
base path elided to the fixed literal `<base>`.

A `secret.revealed` row records the scope and name and neither the value nor its
masked form — a mask repeated into an append-only log accumulates into a partial
disclosure.

#### Append-only: two controls, neither sufficient alone

**1. SQLite triggers.** Migration 008 adds `audit_log_no_update` and
`audit_log_no_delete`, `BEFORE UPDATE` / `BEFORE DELETE` triggers that
`RAISE(ABORT, 'audit_log is append-only: … rejected')`. They stop *this process* from
touching a row: a bug, a careless migration, a compromised route. What they cannot
stop is anyone holding the database file, who can `DROP TRIGGER` in one statement.

They deliberately do **not** police `INSERT`. A row has to land before its hash can
cover its own `AUTOINCREMENT` id, so an insert trigger would either have to forbid the
only legitimate write path or run before the id exists. A hand-written row is caught by
the chain instead, as `unchained_row`.

**2. A keyed hash chain.** Every row stores `prev_hash` — the previous row's
`row_hash` — and

```
row_hash = HMAC-SHA256( deriveSubkey(KeyPurpose.AuditChain), prev_hash ‖ "\n" ‖ canonicalRow )
```

An **HMAC, not a bare digest**, and that is the whole decision: the attacker this
control exists for is exactly the one who can drop both triggers, and that same
attacker can recompute a plain SHA-256 over their forged row and write it back.
Without `PANEL_MASTER_KEY` they cannot produce a value that verifies. The separator
cannot appear in a hex digest, so the two inputs cannot be shifted across the boundary.

`canonicalRow()` is a JSON **array** — `[id, ts, event, actor_ip, user_agent, outcome,
meta_json]` — so nothing depends on object key order. Two details in it are load-
bearing: `id` is included, which is what makes a content swap between two rows
detectable, since each hash is bound to the id it sits at; and `meta_json` goes in as
the **stored string**, not a re-serialisation of the parsed object, so a whitespace-only
edit inside it is a break too.

`audit_chain.anchor_hash` is stored outside the chain and is the only thing that detects
truncation of the newest rows. Delete the head and every surviving row still chains
correctly to its predecessor — nothing but the anchor notices.

#### verify()

`AuditService.verify()` walks the whole table and reports the **first** break:

| reason | what it means |
| --- | --- |
| `unchained_row` | a row with no `row_hash` — inserted by hand, outside `write()` |
| `prev_hash_mismatch` | the row's `prev_hash` is not its predecessor's hash — a row was removed from the middle, or reordered |
| `row_hash_mismatch` | the row's own hash does not cover its contents — a column was edited, or a row was forged without the key |
| `head_mismatch` | the newest row is not the one the anchor names — the head was truncated, or the table emptied |

Also returned: `checked`, `head`, `floor`, `floorId`, and `brokenAtId` — the first
failing row, the newest row for a head mismatch, `null` for an empty table.

**And `hint`, new in M1.6.** A `prev_hash_mismatch` or `row_hash_mismatch` at the
*oldest surviving row* also carries `hint: 'wrong_key_or_genesis'`, because at that
one position the innocent explanation is far more likely than the guilty one: a
changed or mistyped `PANEL_MASTER_KEY` invalidates every row's HMAC at once and so
always presents as a failure at the first row, while a tamper had to leave everything
before the edited row intact and so never does. The same shape covers a restore
against a mismatched `audit_chain` floor, which is the "genesis" half of the name.

`unchained_row` is deliberately excluded: no key can turn a stored hash into `NULL`,
so that reason only ever means a row was inserted by hand. `head_mismatch` is
excluded for the same reason — the anchor is stored plaintext, outside the chain.

The hint changes nothing about the verdict. `ok` is still `false`, the reason and the
row are still named. It exists because an alarm that fires on a legitimate operation
is an alarm that gets ignored, and *that* is how a real tamper goes unnoticed. See
[Key rotation](#key-rotation).

Exposed as `GET /api/audit/verify`, deliberately **not cached**: a cached answer to "has
my audit log been tampered with" is worth nothing. At the row cap it is a bounded scan of
one small table.

#### Retention, without opening a hole

`maxRows` (default `DEFAULT_MAX_AUDIT_ROWS` = 20 000, floored at 2 — one checkpoint plus
one real row) with a `trimCheckEvery` counter that keeps `COUNT(*)` off the hot path.
Trimming has to delete rows from a table whose whole point is that rows cannot be
deleted, so:

- It appends an `audit.trimmed` **checkpoint row** carrying `{removed, throughId, cap}`
  *inside the same transaction and before* the delete, so the checkpoint's id sits above
  the range it describes. A gap in the ids with no checkpoint above it is therefore
  evidence of tampering rather than housekeeping. (A nested `db.transaction()` in
  better-sqlite3 is a savepoint, which is what makes "same transaction" true here.)
- It moves `floor_hash` / `floor_id` to anchor the surviving rows, so the oldest
  survivor's `prev_hash` has something legitimate to point back to. A trim verifies; a
  hand-deletion of the oldest survivor still fails, as `prev_hash_mismatch`.
- It flips `audit_chain.trim_unlocked` to let the delete past the trigger — which is
  gated on `(SELECT trim_unlocked FROM audit_chain WHERE id = 1) = 0` — and relocks it in
  a `finally`, so a rollback leaves it locked. `tests/integration/audit-chain.test.ts`
  asserts that after a legitimate trim the flag is back to `0` and a hand `DELETE` raises
  again.

Note for anyone writing a retention test: `src/server/services/auth-runtime.ts`
constructs the service as `new AuditService({ db, clock, basePath })` — `maxRows` and
`trimCheckEvery` are **not** threaded through the server config, so a test must build an
`AuditService` directly against `getDb()`.

#### The query API

`GET /api/audit` — cursor-based, newest first. `limit` 1–200, `cursor` meaning "id
strictly below this", `event` repeatable (Fastify's default query parser turns
`?event=a&event=b` into an array, which the `auditQuery` schema accepts), and inclusive
ISO-8601 `from`/`to` bounds on `ts`, which sorts lexicographically. A malformed query is
a 400 with the bare reason phrase.

Both routes require a **full** session, not a `pre` one. A `pre` session has passed one
factor, and the log is a record of every authentication attempt, every session and every
secret access — precisely what an attacker holding a stolen password would like to read
before deciding what to do next. Neither route is step-up gated, because reading is not a
state change and requiring a fresh code to look at the log pushes the operator toward not
looking. There is no write route and there never will be: the only way a row appears is
`AuditService.write`.

`requireFullSession` answers **401** both for "no session" and for "a `pre` session", so
a `pre` session learns nothing about which of the two it was.

#### The sentinel sweep, extended to the log itself

The query API changed what a row *costs*. Before M1.5 an audit row was write-only in
practice; now it is readable from inside the panel, for as long as the deployment exists.
`tests/integration/secret-leak.test.ts` therefore sweeps the audit log as a third target
alongside the response bodies and the database files, asserting that:

- writing and revealing a secret records the **reference** (`anthropic_api_key`) and
  neither the value, nor `mask(value)`, nor even its last four characters — while the
  reveal *response* does contain the value, so the test also proves the one deliberate
  exemption is real rather than the sweep being vacuous;
- a failed login records `bad_credentials` and neither the attempted username nor the
  attempted password;
- a base path appearing in a metadata string value is stored as `<base>`;
- and `verify().ok` is still true afterwards, so the sweep is reading an intact chain.

Its database check reads `panel.db`, `panel.db-wal` **and** `panel.db-shm` — see the note
at the end of this document for why that is not optional.

### Generic error responses, and a bug this milestone exposed

`app.setErrorHandler` returns nothing but the status's standard reason phrase, so
a thrown `HttpError(401, 'invalid credentials')` answers `{"error":"Unauthorized"}`.

The handler is registered **before** any `register()` call, and that ordering is
load-bearing: a child encapsulation context inherits the error handler its parent
had at the moment the child was created. Registering it after the routes left every
route under `/api` on Fastify's default handler, which puts the thrown error's
`message` straight into the response body — so the API was answering with
"invalid credentials", "step-up re-authentication required", and
"an authentication attempt is already in flight" as literal strings. Caught by the
integration suite asserting exact bodies; fixed by moving the registration. It is
the same class of leak the M1.3 sentinel sweep caught, arriving through a different
door.

M1.5 found two more instances of the same rule — a child context, and a hook order,
snapshotted at registration time — both of which turned a clean rejection into a body
carrying an internal message:

- **The `Origin`/`Host` hook must be registered *after* `@fastify/cookie`.** Root
  `onRequest` hooks run in registration order. With the origin hook first, a rejected
  request never reached the cookie parser, so `req.cookies` was still `null` when the
  API's `onSend` hook ran on the way out — and reading a cookie there threw *inside*
  `onSend`, which is too late for the error handler to help. Fastify fell back to its
  default serialiser and put the internal message in the body of what should have been
  a bare 403.
- **`req.session` is `undefined`, not `null`, in an `onSend` following a root-hook
  rejection**, because `attachSession` never ran. The Max-Age refresh hook therefore
  reads `req.session ?? null` rather than testing `!== null`. Same failure shape: a
  throw in `onSend` past the point where the error handler can produce a clean response.

Both are recorded as precedents in `CLAUDE.md`, because the rule generalises: anything
installed with `set*` or a root `addHook` must be in place before the `register()` calls
that create the contexts meant to inherit it, and the order among root hooks is the order
they were added.

### Tests

- `tests/unit/auth-delay.test.ts` — the schedule, the cap, monotonicity, the
  arriving-attempt pricing, counter persistence across a restart, and the padding
  arithmetic including the case where the work already overran the target.
- `tests/unit/single-flight.test.ts` — strict serialisation in admission order,
  capacity and the 429, a failing task not wedging the queue, and the N-tasks-cost-
  N-periods property in miniature.
- `tests/unit/totp.test.ts` — the RFC 6238 SHA-1 vectors, encryption at rest under
  the specified AAD, enrolment not enabling until confirmed, re-enrolment clearing
  the watermark, ±1 accepted and ±2 rejected, replay inside the window, replay
  across a restart, and malformed codes rejected rather than throwing.
- `tests/unit/recovery-codes.test.ts` — alphabet bias and confusable pairs, hashes
  only at rest, exactly-once consumption in any order, formatting tolerance, and
  regeneration invalidating the previous set.
- `tests/integration/auth.test.ts` — seeding and non-re-seeding, the fatal boot with
  no user and no credentials, byte-identical answers for a wrong password and an
  unknown username with the dummy path proven taken, the pre-auth session reaching
  nothing, replay and recovery codes over HTTP, the full delay schedule and cap
  observed through the API, success and failure delayed identically, the counter
  surviving a restart, N parallel attempts costing N periods, the 429, origin
  validation, and nothing sensitive at rest or in the audit log.
- `tests/integration/sessions.test.ts` — every cookie attribute including the
  absence of `Domain`, rotation on both privilege changes, idle and absolute
  expiry and the clamp between them, the pre-auth session not sliding, listing,
  revoke-one, revoke-others, the step-up window and its session scoping, and every
  step-up-gated route rejected without one.
- `tests/integration/no-ip-decisions.test.ts` — the static scan, the absent
  lockout table and file, and the behavioural proof.
- `tests/integration/secret-leak.test.ts` — the sentinel sweep, extended again in M1.5
  to the audit log.
- `tests/integration/cookies.test.ts` — both cookie profiles, the two independent
  production guards, and `Max-Age` on the wire including the clamp near the absolute
  deadline and the refresh that does not overwrite a rotation.
- `tests/integration/cookie-discipline.test.ts` — the static scan keeping cookie names
  and attribute assembly inside `plugins/cookies.ts`.
- `tests/integration/csrf.test.ts` — the double-submit token end to end with **real
  `curl` against a real listening socket and a real cookie jar**: a full two-stage login,
  then a missing header, a one-character-flipped header, a token minted for a second live
  session, that same token in *both* halves so they agree with each other, and finally the
  matching pair succeeding with an effect that proves it was not a no-op. Plus, through
  `inject()`, the exemptions (safe methods, login, a cookie that resolves to nothing → 401
  not 403), header-without-cookie and cookie-without-header, and rotation on both pre→full
  and a password change.
- `tests/integration/origin-host.test.ts` — the configured expected origin, every
  rejection verdict, the loopback allowances outside production and their absence inside
  it, the `Upgrade`-header handshake case, `X-Forwarded-*` honoured only under
  `PANEL_TRUST_PROXY` and only from the rightmost hop, the scheme downgrade, duplicated
  headers, and the `/healthz` exemption.
- `tests/integration/rate-limit.test.ts` — both buckets emptying and refilling on the
  injected clock, `Retry-After`, per-session isolation, eviction of full buckets, the
  `/healthz` and 404-sink exemptions, and the assertion that the exempt auth set matches
  the `runAuthAttempt(` call sites one for one.
- `tests/integration/audit-chain.test.ts` — the triggers refusing `UPDATE` and `DELETE`
  through this connection; then, with both triggers dropped, an edited column, a
  whitespace-only edit inside `meta_json`, a deleted middle row, two rows' contents
  swapped, a deleted newest row, an emptied table, and a forged row hashed with a bare
  SHA-256 *and* the anchor moved to match it — each producing the right reason and the
  right `brokenAtId`. Plus retention: the checkpoint's contents and its id above the range
  it describes, the flag relocked, a hand-deletion above the floor still failing, a no-op
  trim under the cap, and the floor cap settling at two rows. Plus the query API: 401 for
  no session, a garbage cookie and a `pre` session; ordering; cursor paging reproducing a
  single large fetch with no duplicates; event and time-range filters; nine malformed
  queries; and `/api/audit/verify` clean, then dirty after tampering.
- `tests/integration/build.test.ts` — that `npm run build` is server-only and succeeds,
  the regression check for the `vite build` step that failed a milestone before any client
  existed.

Mutation-checked for M1.4: replacing `hashToken` with the identity function, storing
the TOTP secret unencrypted, and storing recovery codes unhashed each make the sweep
fail.

Mutation-checked for M1.5 — each of these was applied, the suite run, and the file
restored:

| mutation | what fails |
| --- | --- |
| `csrfTokenFor` HMACs `${sessionId}` alone (drop the token-hash leg) | *rotates the token whenever the session token rotates*, and the wire suite's `csrfA !== preCsrf` — the token stops dying with the session token |
| `csrfTokenFor` HMACs `${sessionTokenHash}` alone (drop the session-id leg) | *binds the token to the session id as well as to the token hash* |
| `chainHash` uses `createHash('sha256')` instead of the keyed HMAC | *refuses a forged row whose hash is a bare SHA-256 of the same inputs* — the attacker with the file and no key now succeeds |
| the `NODE_ENV=production` guard in `cookieProfileFor` is deleted | *refuses the development profile outright when NODE_ENV=production* |
| the `production && !secure` guard in `resolvePublicOrigin` is deleted | *refuses to boot in production with an http public URL* |

The last two are the pair that makes "two independent guards" a claim rather than a
comment: removing either leaves the other's test failing.

### The WAL hole

The sweep's database check reads `panel.db`, `panel.db-wal` **and** `panel.db-shm`.
In WAL mode a write made moments ago has not reached the main file, so **any** test
asserting that something is *absent* from the database must read all three. A check
against `panel.db` alone passed with token hashing removed entirely, which is how the
hole was found. `databaseBytes()` in `tests/integration/secret-leak.test.ts`
concatenates all three; use it rather than re-deriving the list.

---

## Outbound requests

Until M1.7 nothing in this panel initiated a connection. The Telegram transport is the
first door that leads out of the process, and `src/server/utils/outbound-http.ts` is the
only place it opens — the Telegram transport goes through it now, M2.6's "test this API
key" action goes through it next.

### Redaction before egress

Every outbound body passes through the **same** `redactSecrets()` the log destination
uses, plus the base-path elision, immediately before the bytes leave. Twice, in fact,
and deliberately: once in `NotifyService` when the event is rendered, and once in
`TelegramTransport` on the finished body. The second pass is the one that matters for a
string assembled after rendering; the first is what keeps a bad value out of the queue
table, which is storage.

This is the same "second line of defence" argument as the logger, with the same limit:
it is pattern-based, so it catches a credential whose *shape* it recognises and nothing
else. `SecretString` is still the control. What is new is that the destination is a third
party's server rather than the operator's own stdout, so the sentinel test asserts on the
bytes a **fake Telegram server actually received** rather than on a return value.

### The base path and the deep link are the same string

`PANEL_NOTIFY_INCLUDE_LINKS` is off by default, and with it off the base path cannot
leave through this door at all. With it on, the base-path half of the egress pass is
switched off for the whole body — because the link *is* the base path, and eliding it
produces a URL that 404s: the setting turned on and silently broken. Credential
redaction applies either way. The trade is stated where the operator sets it: a Telegram
message is permanent storage on hardware the panel does not control, so turning links on
publishes the prefix to Telegram, to every device signed into that account, and to
anything backing up those devices.

### The URL is a secret

Telegram puts the bot token in the request **path** (`/bot<token>/sendMessage`). So the
URL is credential material, and the two rules that follow are absolute: the transport
logs a fixed event name and a status code, never a URL; and `OutboundUnreachableError`
carries a Node error **code** (`ENOTFOUND`, `UND_ERR_CONNECT_TIMEOUT`) and never the
underlying message, because an undici failure message quotes the URL it failed on.

### `PANEL_OUTBOUND_PROXY`

Node's global `fetch` ignores `http_proxy` and `https_proxy` — the WHATWG spec has no
concept of a proxy — so the proxy is wired explicitly through undici's `ProxyAgent`.
It is an **environment variable, not a stored secret**: it can carry credentials in its
userinfo, so it is elided from log lines like the base path, and `npm run preflight`
reports it as set/unset with no value. `proxyBootWarning()` warns once at boot when a
production panel points it at a non-loopback host, naming neither the host nor the URL:
that hop sees every outbound request, including the one with the token in its path. A
warning and not a refusal — an egress proxy is a legitimate thing to have, and boot is
not the place to argue about it.

### One sender, at-least-once, and nothing in the request path waits

The queue is what keeps a third party's availability out of the panel's own response
times: an HTTP handler enqueues one row and returns. One worker sends at a time, so a
burst cannot open a connection per event, and delivery is **at-least-once** — a send
that succeeds and then fails to record itself sends again. The alternative, at-most-once,
silently drops the alert that mattered. Retries are exponential with full jitter and a
cap, bounded by an attempt count, after which the row is `dead` with an audit row rather
than retried forever. `parameters.retry_after` from a Telegram 429 overrides the computed
delay.

The queue holds the *typed event*, never a rendered string, and `notify()` throws on a
`SecretString` or a non-primitive value rather than redacting it — the same rule, for the
same reason, as `meta_json` validation in the audit log.
