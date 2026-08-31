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
| Cookie name | `__Secure-panel_session` |
| Attributes | `HttpOnly; Secure; SameSite=Strict; Path=/${basePath}`, **no `Domain`** |
| Idle timeout | 8 hours, sliding on use, clamped to the absolute deadline |
| Absolute lifetime | 30 days from the moment both factors were satisfied |
| Pre-auth lifetime | 5 minutes, not sliding |
| Step-up window | 5 minutes, on that one session |

`Secure` is set in development too. Browsers treat `http://localhost` as a secure
context so it costs nothing there, and the `__Secure-` name prefix *requires* it —
a dropped `Secure` attribute becomes an immediate visible failure rather than a
silent downgrade. `__Host-` would be stronger still but requires `Path=/`, which
this cookie cannot have. `Domain` is omitted rather than set to the exact host:
setting it at all widens the cookie to every subdomain.

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

### CSRF and Origin

`SameSite=Strict` on the session cookie is the primary control: no cross-site
request of any method carries it. `src/server/plugins/origin-check.ts` is the
second layer, rejecting a mutating request whose `Origin` is present and does not
match the request's own origin. It covers what `SameSite` does not — a
same-site-but-different-origin document (`http` versus `https`, another port) — and
what it did not always cover, on browsers predating current SameSite semantics.

A request with **no** `Origin` is allowed. Browsers attach `Origin` to every
cross-origin request and to every same-origin mutating request, so an absent header
means a non-browser client, which by definition is not being tricked into acting on
someone else's behalf. Rejecting it would break every command-line client for no
gain.

**Deferred, and stated plainly:** the double-submit CSRF token this document
previously listed for M1.4 is **not** implemented. It needs a non-`HttpOnly`
cookie and a header that a browser client sets, and there is no client until M2.
It is belt to the two controls above, not a replacement for either. It lands with
the client.

### Rate limiting and request size

The global per-IP token bucket the original plan called for is **deliberately not
built** — it is per-IP logic, which is exactly what the operator decision above
rules out. The progressive delay plus the single-flight gate is the replacement,
and it is strictly better against an attacker who can rotate addresses.

Request size is bounded and that bound is IP-independent: `bodyLimit` of 64 KiB on
the Fastify instance, plus per-field maxima in `src/server/utils/zod-schemas.ts` so
a megabyte of "password" never reaches argon2.

A note on the login password schema: it has a maximum but **no minimum length**.
Rejecting a short password at the schema would return instantly, skipping both the
argon2 verification and the delay — a length oracle, and a free attempt. Login
accepts any non-empty password and lets it fail the hash comparison like any other
wrong one. The minimum applies where it belongs, on *setting* a password.

### Audit log

`src/server/services/audit.service.ts`. Events: `setup.completed`,
`two_factor.enrollment_started`, `login.success`, `login.failure`, `totp.failure`,
`recovery_code.used`, `auth.delay_applied`, `session.created`, `session.revoked`,
`password.changed`, `stepup.granted`, `two_factor.disabled`,
`recovery_codes.regenerated`, `secret.revealed`, `secret.changed`,
`base_path.regenerated`.

A failure row carries the reason **category** only — `bad_credentials`,
`bad_totp_code`, `bad_recovery_code`, `replayed_totp_code`,
`two_factor_not_enrolled` — never the attempted username, never the attempted
password, never the code.

Metadata is validated on the way in, and the validation **throws** rather than
scrubbing and continuing: a `SecretString`, a non-primitive value, or anything
matching the credential-shape patterns is rejected outright. Metadata is built from
fixed shapes by this application's own code, so a violation is a programming error,
and the append-only audit log is not the place to discover months later that a
credential has been sitting in it. String values also have the base path elided.

A `secret.revealed` row records the scope and name and neither the value nor its
masked form — a mask repeated into an append-only log accumulates into a partial
disclosure.

The paginated query API and the non-authentication event types are M1.5.

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
- `tests/integration/secret-leak.test.ts` — the sentinel sweep, extended.

Mutation-checked for this milestone: replacing `hashToken` with the identity
function, storing the TOTP secret unencrypted, and storing recovery codes
unhashed each make the sweep fail. The sweep's database check reads `panel.db`,
`panel.db-wal` **and** `panel.db-shm`, because in WAL mode a write made moments ago
has not reached the main file — a check against `panel.db` alone passed with token
hashing removed entirely, which is how that hole was found.
