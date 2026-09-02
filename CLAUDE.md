# Claude Code Control Panel — Phase 1

## Overview
This document describes the architecture, security model, directory layout, and conventions for the Claude Code Control Panel (single-user, Railway-hosted) as built in Phase 1.

**Important filesystem note**: The project now lives at `/home/hossein/projects/cc-panel` on the WSL2 Linux filesystem. It must never be moved back under `/mnt/`. Development runs as the non-root Linux user "hossein", not root.

## Security Model
- **Single user**: Only one admin user exists, seeded via environment variables on first boot.
- **Defense in depth**:
  - Obscurity via secret base path (not a security boundary), kept out of `Referer` and out of every log line.
  - Strong authentication (password argon2id + mandatory TOTP 2FA).
  - **Progressive response delay, not lockout. No per-IP logic anywhere** — see below.
  - Server-side sessions with opaque tokens, SHA-256 hashed in DB.
  - `SameSite=Strict` cookies, strict `Origin`/`Host` validation against a
    *configured* public origin, and a session-bound double-submit CSRF token.
  - Response headers: CSP, HSTS, etc. (see below).
  - Secrets at rest encrypted with AES-256-GCM using HKDF-derived subkeys.
  - Audit log append-only through SQLite triggers *and* a keyed hash chain;
    metadata validation *throws* on anything secret-shaped.
  - Rate limiting with no address in it: one shared anonymous token bucket, one per
    session. Request size and receipt-time limits (IP-independent).
  - Boot-time self-checks refuse to start if critical misconfigurations.

### No per-IP tracking, no lockout (operator decision)
Nothing in the authentication path branches on, rate-limits by, or stores counts
against the client IP address, and nothing locks out. The operator connects through
tunnels with rotating addresses, so per-IP logic would inconvenience the only
legitimate user while an attacker rotates addresses for free; and an account
lockout on a single-user panel is a denial-of-service primitive handed to anyone who
can reach the login endpoint. With `PANEL_TRUST_PROXY` on, the address comes from
`X-Forwarded-For` — attacker-supplied input.

The address is recorded as **display-only** metadata on the session list and the
audit row. `src/server/utils/client-ip.ts` is the single place it is read, and
`tests/integration/no-ip-decisions.test.ts` enforces that by scanning every file
under `src/server` for `req.ip`, `remoteAddress`, `socket.remote*` and
`x-forwarded-for`. Migration 005's `lockouts` table is dropped by 007; the test
asserts it stays gone and that `auth_failures` has no `scope` or `ip` column.

**Do not reintroduce a per-IP bucket, a lockout, or a global rate limiter keyed on
address.** The replacement is the progressive delay plus single-flight execution,
and it is strictly better against an attacker who can rotate addresses.

## Directory Layout on Volume (`/data`)
```
/data
├── panel.db                   # SQLite database
├── home/                      # HOME for the process (set via env)
├── config/
│   └── instance.json          # basePath, installId, schemaVersion
├── global/
│   └── claude-home/           # reserved for future: CLAUDE_CONFIG_DIR
├── projects/                  # reserved for future: per-project directories
└── logs/                      # reserved for future: log files (if any)
```
The container filesystem is ephemeral; all persistent state lives under `/data`.

## Pinned Dependency Versions

Ranges live in `package.json`; the table below records what is actually installed
and verified on disk. Re-check with:

```
node -e "for (const n of ['fastify','@fastify/static','vitest','vite']) \
  console.log(n, require('./node_modules/'+n+'/package.json').version)"
```

| Package              | Range        | Installed | Note                                   |
| -------------------- | ------------ | --------- | -------------------------------------- |
| `fastify`            | `^5.1.0`     | `5.12.1`  |                                        |
| `@fastify/static`    | `^10.1.3`    | `10.1.3`  | v10 is the Fastify 5 line              |
| `@fastify/cookie`    | `^11.1.2`    | `11.1.2`  |                                        |
| `@fastify/websocket` | `^10.0.1`    | `10.0.1`  |                                        |
| `fastify-plugin`     | `^6.0.0`     | `6.0.0`   |                                        |
| `argon2`             | `^0.41.0`    | `0.41.1`  | native; CJS-only, imported by name     |
| `otplib`             | `^13.5.0`    | `13.5.0`  | upgraded from v12 — see below           |
| `better-sqlite3`     | `^11.3.0`    | `11.10.0` |                                        |
| `vitest`             | `^4.1.11`    | `4.1.11`  | `npm test` must print `RUN v4.x`        |
| `vite`               | `^6.0.11`    | `6.4.3`   |                                        |

`@fastify/static` must stay on the v10 line. v7 depends on `fastify-plugin@^4`,
which carries a Fastify 4 peer range, so registering it into this Fastify 5
instance fails the plugin version check at boot; v7 also carries two unfixed
high-severity advisories (authorization bypass via non-canonical URL paths, and
route-guard bypass via path traversal). Nothing in `src/` imports the package
yet — it is needed in Phase 2 to serve the built Vite bundle — and the v10 API
for that use (`register(fastifyStatic, { root, prefix })`, `reply.sendFile()`) is
unchanged from v7.

### otplib: upgraded to v13, decided rather than deferred

**Decision: upgraded v12.0.1 → 13.5.0.** This library guards the second
authentication factor, so "v12 still works" was not an acceptable resting place.

Why the upgrade rather than a justification for staying:

- v12.0.1 was published in 2020 and is unmaintained. It ships as three nested
  `@otplib/*` preset packages plus a `thirty-two` base32 dependency.
- v13 is ESM-native, which matches this project's `"type": "module"`, and its
  primitives come from `@noble/hashes` and `@scure/base` — audited,
  zero-dependency libraries.
- v13 supports the two things this milestone actually needs and v12 does not
  express directly: `verifySync()` returns the matched `timeStep`, and
  `afterTimeStep` provides a built-in exclusive lower bound for replay protection.
  On v12 the replay watermark would have had to be reimplemented by scanning the
  window by hand.

Migration cost was zero: nothing in `src/` imported otplib before M1.4, so there
was no call site to port. `npm audit --omit=dev` reports 0 vulnerabilities at
13.5.0.

The parameters are pinned in `src/server/services/totp.service.ts` and the RFC 6238
Appendix B SHA-1 reference vectors are asserted in `tests/unit/totp.test.ts`, so a
future dependency change that altered the algorithm, the period, or the truncation
fails the suite rather than silently breaking every enrolled authenticator.

`npm audit --omit=dev` must report 0 vulnerabilities. Treat a non-zero count as a
build failure, not a warning.

## Conventions
### Source Code
- **Server** (`src/server/`): Fastify plugins, services, routes, DB, crypto, utils.
- **Client** (`src/client/`): React + Vite SPA, components, pages, lib, styles.
- **Shared** (`src/shared/`): TypeScript types used by both server and client.
- **Tests** (`tests/`): Unit and integration tests with Vitest + Supertest.
- **Scripts** (`scripts/`): Helper scripts (e.g., font downloads).

### Naming
- Files: `kebab-case` for configs and scripts, `PascalCase` for React components, `camelCase` for TS/JS.
- Environment variables: `PANEL_*` prefix.
- Database tables: `users`, `sessions`, `audit_log`, `audit_chain`, `secrets`,
  `auth_failures`, `recovery_codes`. (`lockouts`, from migration 005, is dropped by
  007 — there is no lockout.)

### Error Handling
- Server: Return generic error messages to avoid leaking info (e.g., "Invalid credentials").
- Client: Display user-friendly error with explanation and next action.

### Styling
- Tailwind CSS v4 with a custom theme (see `src/client/styles/globals.css`).
- Dark theme first, respecting `prefers-color-scheme`.
- Animations only on `transform` and `opacity`, respecting `prefers-reduced-motion`.

## Precedents (mistakes that cost a debugging session; do not repeat)

### Fastify child contexts inherit hooks and handlers as of registration time
`setErrorHandler`, `setNotFoundHandler` and root `addHook('onRequest', …)` must all
be installed **before** any `register()` call. A child encapsulation context is
snapshotted from its parent as the child is created, so anything installed afterwards
covers only routes declared at the root.

This was not theoretical. `setErrorHandler` sat after the route registrations, which
left every route under `/api` on **Fastify's default error handler** — and that puts
the thrown `Error`'s `message` straight into the response body. `throw new
HttpError(401, 'invalid credentials')` was answering with the string
`invalid credentials`. The M1.3 sentinel sweep passed only because no `/api` routes
existed yet when it was written; an error message is exactly how a credential reaches
a client verbatim.

Two corollaries that cost their own debugging sessions:

- **Root hook order is registration order.** The `Origin`/`Host` hook must be
  installed *after* `@fastify/cookie`. Installed before it, a rejected request never
  reached the cookie parser, so `req.cookies` was still `null` when the API's `onSend`
  hook ran on the way out — turning a clean 403 into a 500-shaped body carrying an
  internal error message.
- **`req.session` is `undefined`, not `null`, in an `onSend` that follows a root-hook
  rejection**, because `attachSession` never ran. Read it as `req.session ?? null`.
  Throwing inside `onSend` is too late for the error handler: Fastify falls back to
  its default serialiser and puts the internal message in the body.

### An absence assertion against the database must read all three SQLite files
`panel.db`, `panel.db-wal` **and** `panel.db-shm`. The database runs in WAL mode, so
a freshly written row lives in `panel.db-wal` and may not be in `panel.db` at all
until a checkpoint. A sweep that greps only `panel.db` for a plaintext secret passes
while the secret sits in the WAL. `databaseBytes()` in
`tests/integration/secret-leak.test.ts` concatenates all three; use it rather than
re-deriving the path list.

## Security Details (Mapping to Implementation)
See `docs/SECURITY.md` for a detailed mapping of each control to the file(s) that implement it.

## Secret Base Path
- The base path is **obscurity, not a security boundary**. Authentication is the
  boundary. But obscurity is only worth having if it is kept, so it is kept out of
  `Referer` (via `Referrer-Policy: no-referrer`) and out of logs (below).
- All routes (API, SPA, assets) are mounted under `/${basePath}`.
- `GET /healthz` is the only route outside the prefix, returning `{"ok":true}`.
- Base path is generated on first boot if `PANEL_BASE_PATH` is not set, persisted to `/data/config/instance.json`, and logged once at startup.
- The prefix is gated **before routing** by `createBasePathGate()` (installed as
  Fastify's `rewriteUrl` option), which compares the first path segment with
  `crypto.timingSafeEqual` — length first, then bytes. Matching requests pass
  through unchanged; every other request is collapsed onto one constant sink URL
  so all rejections are byte- and timing-identical. Details and accepted
  trade-offs in `docs/SECURITY.md`.
- **Never printed into a log line.** This deploys to Railway, where stdout is
  retained and readable from the dashboard, so pino's default `req` serialiser
  writing `req.url` verbatim meant every valid request left the prefix in
  long-lived storage. Two layers in `plugins/logger-redaction.ts` fix it:
  `createBasePathSerializers()` replaces Fastify's `req`/`res`/`err` serialisers so
  `/${basePath}/api/foo` is logged as `/<base>/api/foo`, and
  `createRedactingDestination()` elides all three spellings (raw, JSON-escaped,
  percent-encoded) from every serialised line — which is what covers response
  logs, error logs, stacks, and hand-built messages. `<base>` is a fixed literal;
  no truncated or hashed form of the real value is ever emitted.
- Still carrying it, by necessity and by design: the first-boot banner (the
  operator has no other way to learn it), the session cookie's `Path` attribute,
  and the shell HTML's `<script src>`. All are documented in `docs/SECURITY.md`.
- The base path reaches the SPA via `GET /${basePath}/bootstrap.js`
  (`application/javascript; charset=utf-8`, `Cache-Control: no-store`), referenced
  from the HTML with a plain `src` attribute. It is **not** an inline script: the
  CSP is `script-src 'self'` with no `unsafe-inline`, and a CSP hash is not usable
  because the script body embeds the per-install base path. React Router will take
  `window.__BASE__` as its `basename` in Phase 2.

## Response Headers
The single source of truth is `SECURITY_HEADERS` in
`src/server/plugins/security-headers.ts`; `docs/SECURITY.md` carries the full
table with rationale. `tests/integration/perimeter.test.ts` asserts the complete
map byte-for-byte on five response shapes (200 HTML, 200 JS, 404, `/healthz`,
500), so it fails if a value changes, a header vanishes, or an unexpected header
appears.

`X-XSS-Protection` is deliberately **not** sent — the auditor it controlled is
gone from every shipping browser and its legacy filtering was itself exploitable.
`Server` and `X-Powered-By` are absent and there is a regression test to keep
them that way.

### Phase 3 follow-up: connect-src and the terminal WebSocket
The CSP ships `connect-src 'self'` with no explicit `wss:` source. Modern browsers
accept `'self'` for a same-origin WebSocket (the socket URL is matched against the
document origin with the scheme upgraded), so this should be correct as written —
but it has not been exercised, because there is no WebSocket yet. **In Phase 3,
verify in a real browser that the terminal WebSocket connects, and only if it does
not, add `wss://<self>` to `connect-src`.** Do not add it pre-emptively.

The handshake's *server-side* obligation is separate and not optional: the upgrade
handler must call `validateRequestOrigin` itself, because a raw HTTP upgrade never
becomes a Fastify request. See **Origin and Host validation**.


## Authentication Flow

API only as of M1.4 — there is no UI yet. Full rationale for every choice below is
in `docs/SECURITY.md`.

1. **First boot**: the one user is seeded from `PANEL_ADMIN_USERNAME` and
   `PANEL_ADMIN_PASSWORD` (argon2id, 64 MiB / t=3 / p=1). On every later boot the
   panel **never re-seeds and never overwrites the stored hash**; if
   `PANEL_ADMIN_PASSWORD` is still set it logs a warning telling the operator to
   remove it and does nothing else. Both variables are optional in `env.ts` for
   exactly that reason — boot fails, with a clear message, only when there is no
   user *and* no credentials to make one from.
2. **Stage 1 — password**: `POST /api/auth/login` verifies the password and issues a
   five-minute `authLevel: 'pre'` session. A full argon2 verification runs even for
   an unknown username, against a dummy hash computed at boot, so timing cannot
   reveal whether a username is valid; the username itself is compared with
   `timingSafeEqual`. A wrong username and a wrong password produce byte-identical
   responses. A `pre` session can reach the second-factor endpoint, the enrolment
   endpoints, `me` and logout — **nothing else**.
3. **Enrolment (mandatory)**: `POST /api/auth/totp/enroll` returns the base32 secret
   and an `otpauth://` URI; `…/verify` requires one valid code before `totp_enabled`
   is set, then returns 10 single-use recovery codes exactly once.
4. **Stage 2 — second factor**: `POST /api/auth/login/totp` accepts a six-digit TOTP
   code or a recovery code, rotates the session token, promotes the row to `full`,
   and is the only place the failure counter resets. Once 2FA is enabled a password
   alone can never produce a usable session.
5. **Step-up**: password **plus** a fresh code, valid 5 minutes on that session only.
   Required for changing the password, revealing or writing a stored secret,
   disabling 2FA, regenerating the base path, and reissuing recovery codes.

### Progressive delay (replaces lockout)
One persisted counter of consecutive failures, keyed on nothing
(`auth_failures`, one row). Target **total** response time: nothing for failures 1–3,
then 500 ms, 1 s, 2 s, 4 s, 8 s, 16 s, capped at 30 s. Implemented as padding to a
target measured from the start of the attempt, so argon2's variance is absorbed
rather than added. Four rules that the mechanism is worthless without:

- The target is priced from the counter **on arrival**, as though the attempt were
  about to fail, so a success and a failure take identical time. Otherwise a correct
  password is the one guess that comes back fast.
- The counter resets **only** after both factors are accepted. A correct password
  followed by a wrong code does not reset it.
- **Single-flight**: one authentication attempt executes at a time, one may queue,
  a third concurrent attempt gets 429 before any credential is read. Without this,
  a thousand parallel requests serve one delay period between them.
- The clock starts at gate acquisition, not socket arrival — measuring from arrival
  would let queue time pay a queued attempt's target and undo the serialisation.
  `docs/SECURITY.md` spells out the conflict and the resolution.

Clock and sleep are injected (`src/server/utils/clock.ts`), so tests assert the
computed target instead of sleeping.

### TOTP
RFC 6238, SHA-1, 6 digits, 30-second step, ±1 step of drift. Secret is 160 bits
from `randomBytes`, stored encrypted under AAD `users:1:totp_secret`, never in
plaintext. **Replay protection**: the last accepted step is persisted and a new code
must come from a strictly greater step, so a code accepted once is dead even inside
its own validity window, and stays dead across a restart. RFC 6238 Appendix B
vectors are pinned in `tests/unit/totp.test.ts`.

## Sessions
- Opaque random tokens (32 bytes from `randomBytes`), stored as SHA-256 hash only.
  Not JWTs — revocation must take effect on the next request.
- `resolve()` compares stored hashes with `timingSafeEqual` across all rows rather
  than an indexed `=`, so no credential comparison in this codebase short-circuits.
- Cookie: `HttpOnly; SameSite=Strict; Path=/${basePath}`, **no `Domain`**, and a
  `Max-Age` mirroring the sliding idle window clamped to the absolute deadline,
  re-stamped on every authenticated response. All three of those are asserted on the
  wire, not in prose, by the `Max-Age` block in `tests/integration/cookies.test.ts`:
  *is set on the wire, five minutes for a pre session and eight hours once full*
  (a `full` session's cookie is `IDLE_TIMEOUT_MS / 1000` = 28800, not the 299 a `pre`
  session gets), *is re-stamped on an authenticated request, tracking the slid
  deadline*, and *is clamped on the wire when the row is near its absolute deadline*
  — with *never exceeds what is left of the absolute lifetime* pinning the pure
  function underneath.
- **Two cookie profiles, chosen from the effective public origin.** https →
  `__Secure-panel_session` with `Secure`. Loopback http outside production →
  `panel_session` with neither. The reason is that Chrome accepts the `Secure`
  *attribute* over `http://127.0.0.1` but not the `__Secure-` *name prefix*, and
  drops the cookie silently — correct header on the wire, nothing in the console,
  no cookie in the jar — so login could never succeed in Chrome over plain http.
  Anything else (http on a routable host, or production without an https origin) is
  a **fatal boot error**, never a silent downgrade. `__Host-` is deliberately not
  used: it mandates `Path=/`, and the path scoping is worth more here.
- **`src/server/plugins/cookies.ts` is the only file that may name a cookie or
  assemble its attributes**, enforced by the static scan in
  `tests/integration/cookie-discipline.test.ts` (same mechanism as the client-IP
  rule). Do not spell a cookie name, call `setCookie`/`clearCookie`, or read
  `req.cookies` anywhere else — go through `runtime.cookies`.
- Idle timeout 8 hours, sliding, clamped to the absolute deadline.
- Absolute maximum 30 days from the moment both factors were satisfied.
- Token rotates on every privilege change: second factor accepted, password changed.
  The row keeps its identity so the list and revoke-others stay coherent. The CSRF
  token is derived from the session token's hash, so it rotates with it and cannot
  fail to.
- **A password change revokes every other session.** Not just a rotation of the
  caller's token — `POST /api/security/password` rotates the caller and then calls
  `revokeOthers`, answers `{ok: true, revokedSessions: n}`, and writes a
  `session.revoked` row with `reason: 'password_changed'`. The only reason to change
  a password is fear that it leaked; rotating one token would leave whoever the
  operator is afraid of holding a live session that the new password does nothing
  about. Server-side sessions exist precisely so revocation lands on the very next
  request.
- `ip` and `userAgent` are recorded for display only. Nothing decides from them.
- Endpoints to list, revoke one, and revoke all but the current.

## CSRF
Three controls, in order of how much they carry:

1. **`SameSite=Strict`** on both cookies. Still the primary control.
2. **Strict `Origin` validation** on mutating requests and on WebSocket handshakes
   (`plugins/origin-check.ts`, below). A present-and-mismatched `Origin` is a 403;
   an **absent** one is allowed, because browsers always send it on mutating and
   cross-origin requests, so absent means a non-browser client that cannot be
   tricked. Allowed but **no longer silent**: since M1.6 an admitted request that
   also carries a session cookie writes an `origin.absent_admitted` audit row with
   the path and method — never the cookie — throttled to one row per fifteen minutes
   with a `suppressed` count. In production it should never fire. The cookie is
   tested for presence only, so a scanner with no cookie cannot flood the log, and
   the presence test costs no database read.
3. **Double-submit token, bound to the session.** Implemented in M1.5.

### The double-submit token
`services/csrf.service.ts` derives it; `plugins/csrf.ts` enforces it.

```
csrfTokenFor(sessionId, sha256(sessionToken))
  = HMAC-SHA256( deriveSubkey(KeyPurpose.CsrfToken), `${sessionId}:${hash}` )  → base64url
```

**Derived, not random, and that is the point.** A bare random value in a cookie
compared against a header proves only that whoever set the cookie also set the
header — which anyone who can write a cookie for this host can do (a sibling
subdomain, an XSS elsewhere on the eTLD+1, a MITM on any http origin sharing the
domain). This value cannot be produced without the HKDF subkey, and it is bound to
two things:

- the session **row id**, so a token minted for one session is rejected on another;
- the SHA-256 hash of that session's **current** token, so it dies the instant the
  session token rotates — second factor accepted, pre→full promotion, password
  change — with no rotation bookkeeping of its own to forget. Nothing stores it:
  the expected value is recomputed from the session cookie the client just
  presented.

On a mutating request three values must agree: the non-`HttpOnly` `…panel_csrf`
cookie, the `X-CSRF-Token` header, and the value derived from the session cookie
presented. Both comparisons are `timingSafeEqual`. The third leg is what a bare
double-submit cannot do: an attacker who writes both halves matches (1) and (2)
perfectly and still fails (3).

Exempt: safe methods (`GET`, `HEAD`, `OPTIONS`) and **requests with no live
session**. Login has no session to bind a token to, and a cookie that resolves to
nothing is not a session — so the route's own guard answers 401 rather than 403,
which also avoids telling an attacker their forged cookie was recognised as one.
`SameSite=Strict` plus the `Origin` check already stop a cross-site login attempt,
and there is exactly one account, so a forced login gains nothing.

`tests/integration/csrf.test.ts` drives the accepting path and all four rejections
with **real `curl` against a real listening socket and a real cookie jar**, so the
pair under test is the one the server wrote and a client echoed back rather than one
the test computed.

## Origin and Host validation
`plugins/origin-check.ts`. **The expected origin is never derived from the
request.** The earlier implementation compared `Origin` against
`` `${req.protocol}://${req.host}` ``, which is circular: an attacker who makes a
browser send `Host: evil.example` and `Origin: https://evil.example` satisfies it,
and every absolute URL built from `Host` points at them.

- The expected value comes from `utils/public-origin.ts`, resolved **exactly once at
  boot** — `PANEL_PUBLIC_URL`, then `RAILWAY_PUBLIC_DOMAIN` (always https), then a
  loopback development fallback. The cookie profile reads the same resolved value,
  so the two can never disagree about what this panel is.
- **Host** is checked on every method, because Host poisoning is not a mutation-only
  problem. Outside production any loopback authority is accepted, so `localhost`,
  `127.0.0.1` and `[::1]` all work without configuration; in production the match is
  exact.
- **Origin** is checked on mutating methods *and on a WebSocket handshake*, matched
  on the `Upgrade` header. A handshake is a `GET`, so a method test alone would wave
  through the most state-changing request this panel will ever serve.
- `X-Forwarded-Host` and `X-Forwarded-Proto` are honoured only when
  `PANEL_TRUST_PROXY` is on, and only their **rightmost** value — the one written by
  the proxy we are actually talking to. A forwarded request admitting `http` when the
  public origin is https is a `scheme_downgrade` 403: the TLS terminator was bypassed.
- A duplicated `Host` or `Origin` header (an array, in Node's parse) is refused
  rather than guessed at.
- `/healthz` is exempt from the Host check. Docker's `HEALTHCHECK` reaches the
  container as `localhost:3000` while production's public host is something else, and
  a health probe that 403s is a container-kill primitive.
- The rejection reason (`host_missing`, `host_mismatch`, `origin_mismatch`,
  `scheme_downgrade`) goes to the log only. The client gets the bare reason phrase.

**Phase 3: the terminal WebSocket handler must call `validateRequestOrigin` itself.**
The validator takes an `OriginCheckInput` shaped like a raw `http.IncomingMessage`
rather than a `FastifyRequest` precisely so it can. A socket upgrade that arrives as
a raw HTTP upgrade never becomes a Fastify request, so no `onRequest` hook will ever
see it — and it is cookie-authenticated and state-changing.

## Rate limiting
There is **no per-IP bucket and no lockout** — see the no-per-IP decision above.
What M1.5 added is two buckets keyed on things an attacker cannot rotate:
`utils/token-bucket.ts` holds the mechanism, `plugins/rate-limit.ts` the policy.

- **Anonymous bucket** — one bucket shared by every request with no live session.
  60 tokens, one back per second. Shared on purpose: the only unauthenticated
  surface is the shell, `bootstrap.js` and the login endpoints, so a legitimate
  client draws on it a handful of times and then stops touching it.
- **Session bucket** — one per session **row id**, 120 tokens, four back per second,
  so a busy operator is never throttled by a stranger and vice versa. Keyed on the
  *resolved* id, never on a raw cookie: keying on unvalidated input would let an
  attacker mint a fresh bucket per request by sending fresh garbage.
- Over the limit is `429` with `Retry-After` in whole seconds, never `0` (a
  `Retry-After: 0` invites a retry guaranteed to fail).
- Buckets that have refilled to capacity are evicted — a full bucket is
  indistinguishable from a new one — so the map is bounded by sessions active within
  one refill window, not by sessions that have ever existed.
- The clock is injected, so the suite proves a refill without waiting for one.

Two buckets rather than one, because either alone is a hole: a single global bucket
lets an anonymous flood empty it and 429 the operator, and a purely per-session
bucket cannot limit unauthenticated traffic at all.

### How this interacts with the progressive delay
**The four `runAuthAttempt` endpoints are exempt from the buckets**
(`DELAYED_AUTH_PATHS`: login, login/totp, totp/enroll/verify, step-up). They already
carry two stronger controls — the progressive delay, which prices guess *n* at up to
thirty seconds, and single-flight execution, which admits one attempt at a time and
429s the third concurrent one. Stacking a bucket on top would add nothing an
attacker notices, because the delay is the binding constraint long before sixty
tokens run out, while handing anyone who can reach the login endpoint a way to spend
the operator's own tokens. `tests/integration/rate-limit.test.ts` asserts that set
has exactly as many members as `routes/auth.ts` has `runAuthAttempt(` call sites, so
a fifth delayed endpoint cannot be added without listing it or failing the suite.

Also exempt: `/healthz` (a 429'd health probe is a container-kill primitive) and the
out-of-prefix 404 sink, because the base-path gate collapses every miss onto one
constant URL before routing and the handler writes a fixed body — a bucket there
would let a stranger's scan spend tokens that matter.

### Size and time bounds
Both in `app.ts`, both IP-independent:

- `bodyLimit` = 64 KiB (`BODY_LIMIT_BYTES`), plus per-field maxima in
  `utils/zod-schemas.ts`. The field bounds stop a megabyte reaching argon2; the body
  limit stops one reaching the JSON parser.
- `requestTimeout` = 30 s (`REQUEST_TIMEOUT_MS`). This bounds *receipt* of the
  request, not the handler, which is what makes it safe to set at all: the
  progressive delay pads a failed login by up to thirty seconds inside the handler,
  and a timeout counting handler time would cut every slow-path login off at the
  knees. It closes the slow-loris shape where a socket dribbles a byte a minute.

The login password schema has a maximum but deliberately **no minimum**: rejecting a
short password at the schema would answer instantly, skipping both argon2 and the
delay, which is a length oracle and a free attempt.

## Secrets at Rest
Implemented in `src/server/crypto.ts`; full rationale in `docs/SECURITY.md`.
- `PANEL_MASTER_KEY` (≥32 bytes base64) is held module-private, never used
  directly for encryption and never exported. Consumers call
  `deriveSubkey(info)` — HKDF-SHA256 with a constant application salt and one
  `info` label per purpose (`KeyPurpose`). A label is never reused.
- AES-256-GCM, fresh 96-bit nonce per write, 128-bit tag, AAD =
  `<table>:<rowId>:<column>` via `columnAad()`.
- Storage format is versioned and self-describing: `v1.<nonce>.<ciphertext>.<tag>`,
  each part base64url. An unknown version is rejected, not guessed at.
- Every authentication failure raises the same opaque `DecryptionError`, so a
  wrong AAD, a tampered byte and a wrong master key are indistinguishable.
- `SecretString` redacts itself in `toString`, `toJSON`, `Symbol.toPrimitive` and
  `util.inspect.custom`; the value comes out only via `.reveal()`. `mask()` gives
  the display form (`sk-ant-…a1b2`, last four characters at most).
- `SecretsRepository` (`src/server/services/secrets.service.ts`) returns
  `SecretString`, never a raw string.
- `src/server/plugins/logger-redaction.ts` scrubs every serialised pino line as a
  second line of defence. It is pattern-based and therefore cannot catch an
  opaque credential — `SecretString` is the control.
- `app.setErrorHandler` returns only the status's standard reason phrase.
  Fastify's default handler echoes the thrown `Error`'s message into the response
  body, which is a direct path from an error message to the client.

## Audit Log
- Table: `audit_log` (id, ts, event, actor_ip, user_agent, outcome, meta_json,
  **prev_hash, row_hash**). `audit_chain` (one row) holds the anchor and the
  retention floor.
- Events (`AuditEvent` in `services/audit.service.ts`): `setup.completed`,
  `two_factor.enrollment_started`, `login.success`, `login.failure`,
  `totp.failure`, `recovery_code.used`, `auth.delay_applied`, `session.created`,
  `session.revoked`, `password.changed`, `stepup.granted`, `two_factor.disabled`,
  `recovery_codes.regenerated`, `secret.revealed`, `secret.changed`,
  `base_path.regenerated`, `audit.trimmed`, `origin.absent_admitted`. No lockout
  event, because there is no lockout.
- A failure row carries the reason **category** only (`bad_credentials`,
  `bad_totp_code`, `bad_recovery_code`, `replayed_totp_code`, `no_pending_login`,
  `two_factor_not_enrolled`) — never the attempted username, password, or code.
- `meta_json` validation **throws** (`AuditMetaError`) on a `SecretString`, a
  non-primitive value, or anything matching the credential-shape patterns in
  `plugins/logger-redaction.ts`. Metadata is built from fixed shapes by our own code,
  so a violation is a bug and should fail loudly rather than be scrubbed into an
  append-only log. Base paths in string values are elided to `<base>`.

### Append-only: two independent controls (migration 008)
Neither one is sufficient, which is why there are two.

1. **SQLite triggers.** `audit_log_no_update` and `audit_log_no_delete` are
   `BEFORE UPDATE` / `BEFORE DELETE` triggers that `RAISE(ABORT, 'audit_log is
   append-only: … rejected')`. They stop *this process* — a bug, a well-meaning
   migration, a compromised route — from touching a row at all. They do not stop
   someone with the database file, who can simply `DROP TRIGGER`.
   INSERT is deliberately **not** policed: a row must land before its hash can cover
   its own `AUTOINCREMENT` id. A hand-written row is caught by the chain instead, as
   `unchained_row`.
2. **A keyed hash chain.** Each row stores `prev_hash` (the previous row's `row_hash`)
   and `row_hash` = `HMAC-SHA256(deriveSubkey(KeyPurpose.AuditChain), prev_hash ‖ "\n"
   ‖ canonicalRow)`. An **HMAC, not a bare digest**, precisely because the attacker
   who can drop the triggers can also recompute a plain SHA-256. Without
   `PANEL_MASTER_KEY` they cannot produce a hash that verifies.

`canonicalRow()` is a JSON **array** — `[id, ts, event, actor_ip, user_agent,
outcome, meta_json]` — so nothing depends on key order. It includes `id`, which is
what makes a content swap between two rows detectable, and the **stored**
`meta_json` string rather than a re-serialisation, so a whitespace-only edit inside
it is a break.

`audit_chain.anchor_hash` lives *outside* the chain and is the only thing that
detects truncation of the newest rows: delete the head and every surviving row still
chains to its predecessor, but nothing matches the anchor.

### verify()
`AuditService.verify(): AuditVerification` walks the whole table and reports the
**first** break, one of `unchained_row | prev_hash_mismatch | row_hash_mismatch |
head_mismatch`, with `brokenAtId` (the newest row for a head mismatch, `null` for an
empty table), `checked`, `head`, `floor` and `floorId`. Exposed as
`GET /api/audit/verify`, deliberately uncached: a cached answer to "has my audit log
been tampered with" is worth nothing.

A hash mismatch at the **oldest surviving row** also carries
`hint: 'wrong_key_or_genesis'`. `row_hash` is an HMAC under a subkey of
`PANEL_MASTER_KEY`, so a changed or mistyped key invalidates every row at once and
therefore always presents as a failure at the first row — while a tamper had to leave
everything before the edited row intact and so never does. `unchained_row` and
`head_mismatch` never get the hint: no key can turn a stored hash into `NULL`, and the
anchor is stored outside the chain. The verdict is unchanged; the hint exists because
an alarm that fires on a legitimate restore is an alarm the operator learns to ignore.
**There is no key-rotation procedure — see *Key rotation* in `docs/SECURITY.md`.**

### Retention
`maxRows` (default 20 000, floored at 2) with a `trimCheckEvery` counter keeping
`COUNT(*)` off the hot path. Trimming:

- appends an `audit.trimmed` **checkpoint row** — `{removed, throughId, cap}` —
  *inside the same transaction, before* the delete, so the checkpoint's id sits above
  the range it describes. A gap in the ids with no checkpoint above it is evidence of
  tampering rather than housekeeping.
- moves `floor_hash`/`floor_id` to anchor the surviving rows, so a legitimate trim
  still verifies while a hand-deletion above the floor fails as `prev_hash_mismatch`.
- flips `trim_unlocked` to let the delete through the trigger (which is gated on
  `(SELECT trim_unlocked FROM audit_chain WHERE id = 1) = 0`) and relocks it in a
  `finally`, so a rollback leaves it locked.

`services/auth-runtime.ts` constructs the service as
`new AuditService({ db, clock, basePath })` — **`maxRows`/`trimCheckEvery` are not
threaded through**, so a test exercising retention must build an `AuditService`
directly against `getDb()`.

### The query API
`GET /api/audit` — cursor-based, newest first, `limit` 1–200, `cursor` = "id strictly
below this", `event` repeatable, inclusive ISO-8601 `from`/`to` (`ts` sorts
lexicographically). `GET /api/audit/verify` as above.

Both require a **full** session, not a `pre` one: the log records every
authentication attempt, every session and every secret access — exactly what an
attacker holding a stolen password would want to read first. Neither is step-up
gated, because reading is not a state change and demanding a fresh code to look at
the log pushes the operator toward not looking. There is no write route and never
will be.

### Never a secret, and never the base path
`tests/integration/secret-leak.test.ts` now sweeps the audit log too, because the
query API changed what a row costs: a row is readable from inside the panel, forever.
It asserts that writing and revealing a secret records the *reference*
(`anthropic_api_key`) and neither the value, nor `mask(value)`, nor its last four
characters; that a failed login records `bad_credentials` and neither the attempted
username nor the attempted password; and that a base path in a metadata string is
stored as `<base>`. Like every absence assertion against SQLite, it reads
`panel.db`, `panel.db-wal` **and** `panel.db-shm` — see the WAL note under
Precedents.

## CSP (Content Security Policy)
```
default-src 'none';
script-src 'self';
style-src 'self';
img-src 'self' data:;
font-src 'self';
connect-src 'self';
frame-ancestors 'none';
base-uri 'none';
form-action 'self'
```
Byte-identical in development and production. No `unsafe-inline`, no
`unsafe-eval`, no CSP hashes. See the Phase 3 follow-up note above for
`connect-src` and the terminal WebSocket.

## Deployment (Railway)
- Docker image runs as non-root user (uid 10001).
- `HOME` set to `/data/home`.
- Volume mounted at `/data`.
- Required environment variables:
  - `PANEL_MASTER_KEY` (32 bytes base64)
  - `PANEL_ADMIN_USERNAME`
  - `PANEL_ADMIN_PASSWORD` (min 12 chars, not in weak list)
  - `PANEL_PUBLIC_URL` — the https origin the panel is served on. **Required in
    production** unless `RAILWAY_PUBLIC_DOMAIN` is present (Railway sets it, and it
    always implies https). Resolved in exactly one place,
    `src/server/utils/public-origin.ts`, and read from there by both the cookie
    profile and the Origin/Host validator so the two cannot disagree. Never derived
    from a request header.
- Optional:
  - `PANEL_BASE_PATH` (if unset, generated and logged)
  - `PANEL_TRUST_PROXY` (default true)

## Current State
Phase 1 is **in progress**. This section tracks what actually exists on disk, not
what the plan calls for.

- **M1.1 — scaffold and boot: done.** `env.ts` with boot-time self-checks, `/data`
  layout creation, `db.ts` with a numbered migration runner, migrations 001–006.
- **M1.2 — perimeter: done.** Secret base path with a constant-time pre-routing
  gate, generic 404, `/healthz`, the full response-header set, the bootstrap
  script, generic error responses. Follow-up `fix(m1.2): elide base path from
  logs` keeps the prefix out of every log line.
- **M1.3 — crypto and secret handling: done.** HKDF subkeys, AES-256-GCM with
  row-scoped AAD, `SecretString`, `mask()`, logger redaction, `SecretsRepository`.
- **M1.4 — authentication: done (API only, no UI).** argon2id password hashing with
  the constant-time dummy-hash path; two-stage login with a limited `pre` session;
  mandatory TOTP with replay protection; single-use recovery codes; opaque
  server-side sessions with rotation, sliding idle and absolute deadlines; step-up
  re-authentication; the progressive delay with single-flight execution replacing
  lockout; `Origin` validation; request size limits; the audit log; migration 007.
  otplib upgraded to v13. **Deferred with reason: the double-submit CSRF token
  (needs the M2 client) and the paginated audit query API (M1.5).**
- **M1.5 — request integrity and audit: done (API only, no UI).** Part 0: two cookie
  profiles chosen from the effective public origin, so the `__Secure-` prefix no
  longer makes login impossible in Chrome over loopback http, with
  `plugins/cookies.ts` the only file allowed to name a cookie. Part 1: a server-only
  build (`tsc -p tsconfig.build.json`; `vite.config.ts` deleted, since there is no
  client to bundle) with `tests/integration/build.test.ts` as the regression check.
  Part 2: a password change now revokes every other session; the session-bound
  double-submit CSRF token, tested end to end with `curl`; `Origin`/`Host` validation
  against a configured public origin resolved in one place, with the WebSocket
  handshake covered and `X-Forwarded-*` honoured only from the immediate hop under
  `PANEL_TRUST_PROXY`; IP-free rate limiting (one shared anonymous bucket, one per
  session, `Retry-After`, auth paths exempt) plus `bodyLimit` and `requestTimeout`;
  migration 008's append-only triggers and HMAC hash chain with `verify()`, retention
  writing an `audit.trimmed` checkpoint, and the paginated `GET /api/audit` query API
  behind a full session. **Nothing deferred from M1.5.**
- **M1.7 — notifications: designed, not built.** The Telegram transport is specified
  in `PLAN.md` under *M1.7 — Notifications (Telegram transport): the design*, and the
  Phase 3 consumer it exists for under *Phase 3 preview*. No code exists: no
  `notification_queue`, no migration 009, no transport, no route. Two things in that
  design reach back into finished modules and should not come as a surprise when it
  is built: the Telegram credentials want AAD `secrets:telegram:bot_token` /
  `secrets:telegram:chat_id`, which is a **`v2` payload version for
  `SecretsRepository`** binding a ciphertext to `(scope, name)` rather than to the row
  id — strictly stronger given `UNIQUE (scope, name)`, and the reason is written out
  there; and the Phase 3 hook endpoint is a **second Fastify listener bound to
  `127.0.0.1`**, outside the base path, bearer-token only, that must never see a
  session cookie.
- **M2 — application shell and design system: not started.** No React, no
  Tailwind, no client code at all yet; `/${basePath}/` serves a placeholder page.
- No terminal or Claude Code integration (Phase 3).

## Next Steps (Phase 2)
- Implement project creation and management.
- Spawn isolated Claude Code sessions per project.
- Provide a `settings.json` editor for each project.
- Integrate Railway deploy hooks (if desired).

---
*This document will be updated as the project progresses.*