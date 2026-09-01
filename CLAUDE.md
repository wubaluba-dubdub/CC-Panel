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
  - `SameSite=Strict` cookies plus strict `Origin` validation on mutating requests.
  - Response headers: CSP, HSTS, etc. (see below).
  - Secrets at rest encrypted with AES-256-GCM using HKDF-derived subkeys.
  - Audit log append-only; metadata validation *throws* on anything secret-shaped.
  - Request size limits (IP-independent).
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
- Database tables: `users`, `sessions`, `audit_log`, `secrets`, `auth_failures`,
  `recovery_codes`. (`lockouts`, from migration 005, is dropped by 007 — there is no
  lockout.)

### Error Handling
- Server: Return generic error messages to avoid leaking info (e.g., "Invalid credentials").
- Client: Display user-friendly error with explanation and next action.

### Styling
- Tailwind CSS v4 with a custom theme (see `src/client/styles/globals.css`).
- Dark theme first, respecting `prefers-color-scheme`.
- Animations only on `transform` and `opacity`, respecting `prefers-reduced-motion`.

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
  re-stamped on every authenticated response.
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
  The row keeps its identity so the list and revoke-others stay coherent.
- `ip` and `userAgent` are recorded for display only. Nothing decides from them.
- Endpoints to list, revoke one, and revoke all but the current.

## CSRF
`SameSite=Strict` is the primary control. `plugins/origin-check.ts` adds strict
`Origin` validation on mutating requests — a present-and-mismatched `Origin` is a
403; an **absent** one is allowed, because browsers always send it on mutating and
cross-origin requests, so absent means a non-browser client that cannot be tricked.

**The double-submit CSRF token is deliberately not implemented yet.** It needs a
non-`HttpOnly` cookie and a header a browser client sets, and there is no client
until M2. Do not treat this section as complete; it is belt to the two controls
above, and it lands with the client.

## Rate limiting
There is **no** global per-IP token bucket, and there must not be one — see the
no-per-IP decision above. Request size is bounded IP-independently: `bodyLimit` 64
KiB plus per-field maxima in `utils/zod-schemas.ts`. The login password schema has
a maximum but deliberately **no minimum**: rejecting a short password at the schema
would answer instantly, skipping both argon2 and the delay, which is a length
oracle and a free attempt.

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
- Table: `audit_log` (id, ts, event, actor_ip, user_agent, outcome, meta_json).
- Events (`AuditEvent` in `services/audit.service.ts`): `setup.completed`,
  `two_factor.enrollment_started`, `login.success`, `login.failure`,
  `totp.failure`, `recovery_code.used`, `auth.delay_applied`, `session.created`,
  `session.revoked`, `password.changed`, `stepup.granted`, `two_factor.disabled`,
  `recovery_codes.regenerated`, `secret.revealed`, `secret.changed`,
  `base_path.regenerated`. No lockout event, because there is no lockout.
- A failure row carries the reason **category** only (`bad_credentials`,
  `bad_totp_code`, `bad_recovery_code`, `replayed_totp_code`,
  `two_factor_not_enrolled`) — never the attempted username, password, or code.
- `meta_json` validation **throws** on a `SecretString`, a non-primitive value, or
  anything matching the credential-shape patterns. Metadata is built from fixed
  shapes by our own code, so a violation is a bug and should fail loudly rather
  than be scrubbed into an append-only log. Base paths in string values are elided.
- The paginated query API and non-auth event types are M1.5.

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