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
├── exports/                   # reserved for M2.6: portable exports, with incoming/
├── run/
│   └── panel.run              # the watchdog's run marker — present means running
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
| `undici`             | `^7.29.1`    | `7.29.1`  | outbound only — see below              |
| `vitest`             | `^4.1.11`    | `4.1.11`  | `npm test` must print `RUN v4.x`        |
| `vite`               | `^6.0.11`    | `6.4.3`   |                                        |

`undici` is a direct dependency and not "the thing Node already bundles". Node's global
`fetch` **ignores `http_proxy` and `https_proxy`** — the WHATWG spec has no notion of a
proxy — and `api.telegram.org` is unreachable from this operator's country without one, so
a transport on the global `fetch` works on Railway and fails locally with a network error
indistinguishable from a wrong bot token. The proxy needs an explicit `ProxyAgent`, and a
dispatcher from the standalone package is not the same object graph as the `fetch` baked
into Node: pairing them is not a supported combination. Every outbound request goes through
`src/server/utils/outbound-http.ts`.

The range is `^7.29.1` rather than the `^7.16.0` M1.7 was written against, because
`7.0.0`–`7.28.0` carry a high-severity advisory set — sixteen of them, and
[GHSA-g9mf-h72j-4rw9](https://github.com/advisories/GHSA-g9mf-h72j-4rw9), an unbounded
decompression chain via `Content-Encoding`, is on the `fetch` path this panel uses rather
than on the WebSocket client it does not. `7.29.1` is the patched release inside the same
major, and `outbound-http.ts` imports only `Agent`, `ProxyAgent`, `fetch` and the
`Dispatcher` type, none of which changed. The floor is in the range, not just the lockfile,
so a fresh `npm install` cannot resolve back down into the vulnerable window.

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
  `auth_failures`, `recovery_codes`, `notification_queue`, `notification_state`.
  (`lockouts`, from migration 005, is dropped by 007 — there is no lockout.)

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

### A commit that adds a route extends EXPECTED_ROUTE_TREE in the same commit
`tests/integration/secret-leak.test.ts` pins the whole route table as a literal, and a
new route makes it fail. That is the mechanism working, not a chore to catch up on: the
moment to decide what a route may and may not put in a response body is while it is
being written, and the sweep is what proves the decision. Extend the literal, and add
the new path to the swept `urls` list when it is reachable without a session.

### An absence assertion against the database must read all three SQLite files
`panel.db`, `panel.db-wal` **and** `panel.db-shm`. The database runs in WAL mode, so
a freshly written row lives in `panel.db-wal` and may not be in `panel.db` at all
until a checkpoint. A sweep that greps only `panel.db` for a plaintext secret passes
while the secret sits in the WAL. `databaseBytes()` in
`tests/integration/secret-leak.test.ts` concatenates all three; use it rather than
re-deriving the path list.

## Security Details (Mapping to Implementation)
See `docs/SECURITY.md` for a detailed mapping of each control to the file(s) that implement it.

## Phase 2 specifications
- `docs/PORTABILITY.md` — the portable export/import format (R1, R2). Read it before
  touching project identity or secret AAD: it is the reason projects carry a UUID.
- `docs/FILES.md` — the project file browser (R4), including the one containment function
  every path-taking route must call.

## Secret Base Path
- The base path is **obscurity, not a security boundary**. Authentication is the
  boundary. But obscurity is only worth having if it is kept, so it is kept out of
  `Referer` (via `Referrer-Policy: no-referrer`) and out of logs (below).
- All routes (API, SPA, assets) are mounted under `/${basePath}`.
- `GET /healthz` is the only route outside the prefix — see *The health endpoint* below.
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

## The health endpoint
`GET /healthz` (`src/server/routes/healthz.ts`), outside the base path, no session, and
the only route Railway calls. Railway polls it until it gets a 200 and **only then**
makes the new deployment live; it never polls again. So the two directions are
asymmetric — a failure during boot costs a deployment and leaves the previous one up,
while a premature 200 pushes a broken deployment live — and it therefore asserts
**reachability plus a bounded read**: one statement counting `schema_migrations` against
the number of migrations this build shipped, which also answers "is the database fully
migrated". No write probe (WAL churn on every poll forever). Exactly `{"ok":true}` on
success and `{"ok":false}` with a `503` on failure — the reason is logged, never sent,
because the endpoint is unauthenticated. Plus `Cache-Control: no-store`, the one caching
directive anywhere in the panel: a response with none is heuristically cacheable, and
"the health endpoint said fine" must never come out of a cache. Exempt from `Host`
validation and rate limiting, because a 403 or a 429 there is a container-kill
primitive.

## Resource metrics
`GET /api/metrics` (`src/server/routes/metrics.ts`), full session, inside the base path,
inside the rate limiter. `src/server/services/resources.service.ts` holds the readers and
the sampler. Full rationale in `PLAN.md` §*Resource usage*; the parts that are decisions
rather than code:

- **cgroup v2, not `os`.** `os.totalmem()`/`os.freemem()` report the **host's** memory
  from inside a container, so on Railway a 1 GB service would report tens of gigabytes,
  mostly free, right up to the OOM kill. The figures come from `memory.current`,
  `memory.max`, `cpu.stat`'s `usage_usec` and `cpu.max`. v2 is detected by the presence
  of `cgroup.controllers`; a v1 layout is **not** read, because v1's files mean subtly
  different things and a half-supported hierarchy produces plausible wrong numbers.
- **Three states that are not numbers**, each a named outcome (`LimitReading`,
  `QuotaReading`, `UsageReading`) rather than a `number | null` the caller can misread:
  `memory.max` = the literal `max` is `unlimited` → `limitBytes: null`; `cpu.max` quota
  = `max` is `unlimited` → `percentOfQuota: null`; and a file that is absent or garbage
  is `unavailable`, which is not the same as unlimited.
- **The source is chosen once per snapshot, for all three gauges**, from whether
  `memory.current` is readable — a snapshot that took memory from the host and CPU from
  a cgroup could not be described honestly. `meta.source` and `meta.containerized` say
  which; the client is never left to infer it. `containerized` is `memory.max` being
  *present*, whatever it holds.
- **CPU is a rate, so it needs two samples**: `percent = Δusage_usec / (Δwall_µs ×
  cores) × 100`, where `cores = quota / period`. The `× cores` term is the one that is
  easy to omit and it is wrong by exactly the core allowance. Before the second sample
  the answer is `null`, never `0` — a fabricated zero renders as an idle panel however
  busy it is.
- **One shared sampler, running only while someone polls.** Armed by the first request,
  1000 ms cadence, disarmed after 60 s with no request; `stop()` drops the previous
  sample, so a restart after an idle gap does not divide a CPU delta by an unknown
  interval. Two requests inside one cadence window get the identical cached snapshot,
  so a second browser tab is free. Neither of the two obvious designs is used: computing
  per request would make every poll sleep for the CPU window, and a permanent timer is a
  wakeup a second on an idle panel.
- **Raw numbers and nulls only. No formatted strings, ever.** `"512 MB / 1 GB"` is a
  *translated* string — different digits, decimal mark and separator for this operator —
  and R3 says the server has no locale. `tests/integration/metrics.test.ts` asserts the
  set of string-valued fields in the body is exactly `disk.path`, `memory.source`,
  `meta.source`, `meta.sampledAt`, and that none of them carries a `%` or a unit.
- `disk` reads `statfs` on `PANEL_DATA_DIR` plus the size of `panel.db` and its two
  sidecars. `availableBytes` is `bavail`, not `total - used`: the difference is space an
  unprivileged process cannot have, which is the question M2.4's import cap asks.
  `projects/` is deliberately **not** walked — a recursive walk of checkouts and
  `node_modules` on a one-second cadence is the display becoming its own load.
- Not built here: per-project attribution (there are no projects, and `perProject` is
  declared absent rather than empty). Threshold-crossing alerts were also deferred from
  M1.7 for a structural reason and are built in M1.8 — see below.

## The resource watchdog
`src/server/services/watchdog.service.ts` (the watcher, the run marker, the OOM counter)
and `services/resource-alerts.ts` (the pure crossing machine and its persistence).
Migration 010. Always on from boot to shutdown at a 30 s cadence; no route, no UI — M2.7
is where it becomes visible. Full rationale in `PLAN.md` §*Built in M1.8*; the decisions
rather than the code:

- **A second sample pair, not a second use of the first.** The poll-driven sampler is
  armed by a request and disarmed 60 s after the last one, so a crossing that happens
  while nobody is polling is a crossing nothing observes — an alert machine bolted to it
  would fire *when the operator opens the panel*, the one moment they are already looking.
- **They share no mutable state, and that is structural.** Every reader in
  `resources.service.ts` is a pure function of a path, and the CPU rate is `cpuRate()`,
  which takes `previous` as an **argument**. Each consumer holds its own previous sample.
  The failure this rules out is not a crash: one shared slot would make each divide its
  delta by the other's interval, and at 1000 ms against 30 000 ms the answer is wrong by a
  factor of thirty — still a number, still in range, still plausible on a dashboard.
- **Alerts fire on a crossing, not on a level**, with a *separate, lower* clear threshold
  (derived, ten points down) and a 30-minute cooldown. A sustained 95 % is one message.
  `alerted` is tracked separately from `above`/`below` so that **every alert that was sent
  gets a recovery and nothing else does** — a recovery for an alert the cooldown swallowed
  would be a message about something the operator has no record of.
- **A missing denominator disables a rule; it never defaults one.** `memory.max` holding
  the literal `max`, or no cgroup v2 at all, means there is nothing for a fraction to be a
  fraction of — so the machine *freezes* (no transition, no message, no bookkeeping lost)
  rather than reading as 0 %. The operator finds out from the boot log line and from
  `npm run preflight`, which reads the real cgroup and says which rules can arm.
- **Disk is `(total - available) / total`, not `used / total`.** `available` is `bavail`,
  the field M2.4's import cap already reads, and the question the alert answers is whether
  the panel can still *write* — a block reserved for root is not space it has. This reads a
  few points higher than `df` on a filesystem with a reserve, deliberately. It matters more
  than it looks: a full volume stops the **audit log**, so the disk rule is protecting the
  panel's own tamper-evidence and not just the feature that filled the disk.
- **`oom_kill` from `memory.events`** (hierarchical), falling back to
  `memory.events.local`. It counts **processes**, not events. A `null` stored baseline is
  not zero — it means no baseline has been read, so the first sample after an upgrade
  adopts the counter instead of announcing every kill that predates this build; a *lower*
  reading is a new cgroup and resets the baseline. **What it can see is a child** — an
  agent, a build, a git subprocess — because a kill that takes the whole container cannot
  be reported by the process that died.
- **That case is covered from the other side: the run marker.** `/data/run/panel.run` is
  written at boot, rewritten with a fresh `lastSeenAt` and the last memory reading on every
  tick, and **removed by `onClose`** — which both signal handlers go through. Present at
  boot means the previous run was not given the chance to shut down or did not take it.
  Railway, `docker stop` and Ctrl-C all send SIGTERM, so a normal redeploy is clean; what
  cannot be separated is an OOM kill from a redeploy whose shutdown overran the grace
  period, because both are a SIGKILL. Hence the message says **did not shut down cleanly**
  and never *crashed*, and carries the previous run's last memory reading so the operator
  can tell which it probably was. A file and not a table, because its *absence* is the
  signal and it must be readable by a boot that has not opened the database — and the
  crashes worth detecting are the ones that can involve the database or the volume.
- **No sustained-CPU rule, and that is a decision.** An agent waiting on a model response
  is idle, so CPU is not this panel's binding constraint — memory and the upstream API are —
  and a busy agent at 95 % is the product working. An alert nobody can act on is what
  teaches an operator to ignore the channel that also carries "someone signed in". The
  figure is still *measured*, because it is what says what the panel was doing when it died:
  the marker carries it and the unclean-restart message reads it.
- **The alert state lives in `notification_state` beside the drop counter**, read once per
  tick and written only when something changed — an idle panel does not dirty a page every
  thirty seconds. The four watchdog audit events have **explicit `null` rules** in
  `notification-rules.ts`: the watchdog enqueues its own typed event with the numbers in it,
  and a rule there would turn the row into a headline-plus-a-time `security_alert` — the
  operator would get "memory crossed a threshold" and not "940 MB of 1 GB". This is the one
  place in that map where `null` means *notified elsewhere*.

## Notifications (Telegram)
Outbound only. The inbound hook endpoint that Phase 3's agents will call is **not** built
— no second listener, no bearer credentials. Full rationale in `PLAN.md` §*M1.7 —
Notifications (Telegram transport)* and §*Built in M1.7 — and the six places it departs
from the design above*; `docs/SECURITY.md` §*Outbound requests* for the egress rules. The
parts that are decisions rather than code:

- **The queue carries a typed event, not a rendered string.** `NotifyEvent` in
  `services/notification-render.ts` is a discriminated union — `turn_complete`,
  `resource_alert`, `security_alert`, `test`, and M1.8's `oom_kill` and `unclean_restart`;
  the worker renders it at send time. The `kind` CHECK in the queue enumerates them, so a
  new kind needs a migration, and `tests/unit/db.test.ts` fails if one is added without. A pre-rendered string would force a later transport to accept Telegram's shape —
  the 4096-character cap and the truncate-then-attach behaviour are properties of Telegram,
  not of "a notification" — and would have had to be rendered by whichever producer
  enqueued it. `notification_queue.event_json` therefore holds the event, and
  `kind`/`throttle_key` are duplicated out of it as columns so the worker's query and the
  throttle query do not parse every row's JSON.
- **This is the one sanctioned server-side locale.** R3 says the server has no locale and
  the client owns every human string; a Telegram message has no client, so the event
  carries `locale` (`en`/`fa`, `PANEL_NOTIFY_LOCALE`) and `notification-render.ts` is the
  only translation table on the server. Do not grow a second one.
- **`services/notification-rules.ts` is exhaustive over `AuditEvent` by construction.**
  `satisfies Record<AuditEventName, AlertRule | null>` makes a new audit event a compile
  error until someone decides whether it notifies, and a silent event is an explicit `null`
  with its reason in a comment rather than an absence. `NotifiedAuditEvent` is derived back
  out as a mapped type so it cannot drift. Reaching the queue from the audit log goes
  through `AuditService.setObserver()` — a post-commit observer, so the audit log has no
  idea a notification layer exists and cannot be broken by one.
- **Delivery is at-least-once and the code says so.** A claim is an `UPDATE … WHERE state =
  'pending'` checked for `changes === 1`, so two workers cannot take one row; a send that
  succeeds and then fails to record it sends again. At-most-once would instead silently drop
  the alert that mattered. Backoff doubles from one second to a fifteen-minute ceiling,
  jittered **±20 %** — not "full jitter", which randomises over `[0, computed)` to
  decorrelate a fleet of clients and there is exactly one sender here — and is bounded by
  an attempt count (**15** since M1.8, so 77 minutes of trying — the figure is
  `totalRetryWindowMs()` and is derived from the three backoff constants rather than
  written down, because it had been written down twice and both copies were wrong), after
  which the row is `abandoned` and a `notification.abandoned` audit row is written. Twelve
  attempts was thirty-two minutes, which is inside the length of a third-party outage the
  operator has no part in.
- **`not_configured` retries without consuming an attempt.** Otherwise every alert queued
  between first boot and the operator's first visit to the settings screen dead-letters —
  and those (`setup.completed`, the first `login.success`) are the ones most worth keeping.
- **A full queue refuses the newest event**, counting drops in `notification_state` and
  auditing once per fill. The first alert of an attack is the most valuable and the
  thousandth is the most expendable, so evicting the oldest discards the wrong end.
- **Plain text, no `parse_mode`, ever.** A project name containing `_` or `*` is either a
  400 from Telegram or a message with pieces missing, and there is no escaping scheme worth
  maintaining for the panel's own alerts. Over 4096 **code points** the message goes as a
  document instead, split on a marker rather than mid-word. A 429's
  `parameters.retry_after` overrides the computed backoff rather than being averaged with
  it.
- **`api.telegram.org` is named in exactly one file** (`services/telegram.transport.ts`),
  enforced by a static scan in `tests/unit/telegram-transport.test.ts` — the same mechanism
  as the client-IP and cookie rules, and like them it strips comments before scanning.
- **The URL is a secret.** Telegram puts the bot token in the request *path*, so the
  transport logs an event name and a status code and never a URL, and
  `OutboundUnreachableError` carries a Node error **code** and never the underlying
  message, which quotes the URL it failed on.
- **`PANEL_NOTIFY_INCLUDE_LINKS` is off by default, and it is also what switches off the
  base-path half of the egress redaction.** The two milestone rules "elide the base path
  from every outbound body" and "a message may end with a deep link into the panel" cannot
  both hold literally — the link *is* the base path, and eliding it yields a URL that 404s:
  the setting on and silently broken. With links off the prefix cannot leave at all; with
  links on the operator has said in one deliberate setting that it may. Pattern-based
  credential redaction applies either way, and both passes run: at enqueue (the queue is
  storage on the volume) and again on the finished body.
- **Credentials are reported as set/unset plus a length, never `mask()`.** Last-four of a
  nine-digit chat id discloses most of it. `services/telegram-config.ts` is the only reader.
- **No route writes the credentials.** `PUT /api/secrets` with scope `telegram` already
  does it under step-up with a `secret.changed` row, so M2.5's UI needs no new endpoint. The
  three routes that do exist are `GET /api/notifications/telegram` (status),
  `POST /api/notifications/test` (full session, **no** step-up — a test send discloses
  nothing, and demanding a fresh code to check whether notifications work pushes the
  operator toward not checking; `202` with a queue id) and
  `GET /api/notifications/queue/:id`.

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
- **The version selects the AAD scheme, not the cipher.** `v1` binds a `secrets` row's
  ciphertext to its row id (`secrets:<rowId>:payload`); `v2`, the write version since
  M1.7, binds it to `(scope, name)` — which `UNIQUE (scope, name)` makes strictly
  stronger, because the row-id form does not stop an attacker with database write access
  from **relabelling** a row. Reads pick the scheme from the stored prefix.
  Injectivity comes free from a check `columnAad()` already had: it refuses a `:` in the
  table and the column, and `name` is passed as the column, so `('project:7', 'x')` and
  `('project', '7:x')` cannot collide — the second is refused. A `scope` may contain
  colons, which it must, since project scopes are `project:<uuid>`. `SecretsRepository.upgradeLegacyPayloads()` re-encrypts `v1` rows at boot —
  in code, because SQL cannot re-encrypt and a migration that threw would brick the boot.
  A build older than M1.7 cannot read an upgraded row; a pre-M1.7 backup is the way back.
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
  `base_path.regenerated`, `audit.trimmed`, `origin.absent_admitted`,
  `notification.sent`, `notification.abandoned`, `notification.dropped`,
  `resource.threshold_crossed`, `resource.threshold_cleared`, `resource.oom_kill`,
  `panel.unclean_restart`. No lockout event, because there is no lockout.
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

## Operator commands
Three commands, all in `src/server/cli/`, all shipped in the image so they can be run in
Railway's shell as `node dist/server/cli/<name>.js`. Full runbook: `docs/DEPLOY.md`.

- **`npm run preflight`** — validates the whole configuration and prints a pass/fail line
  per fact, non-zero exit on any failure. It **must not change anything**, so it opens its
  own read-only connection rather than going through `initDb`, which would apply
  migrations as a side effect; and it prints **no secret value** — for each credential only
  whether it is set and how many characters, which catches a truncated paste and a variable
  that never arrived. The base path is a secret under that rule too.
- **`npm run backup -- <path>`** — SQLite's online backup API, then it *verifies what it
  wrote* (`integrity_check`, migration count, audit chain). `cp panel.db` is not a backup:
  in WAL mode a committed row lives in `panel.db-wal` until a checkpoint, so the main file
  alone is an older database — measured on a fresh install, a plain copy could not be
  opened at all, because every table the migrations created was still only in the WAL.
- **`npm run telegram:set`**, **`telegram:test`**, **`telegram:discover`** — configure the
  bot token and chat id, send a test message, and list the chats the bot can see. The token
  is read from a TTY (with echo off) or from a pipe, **never from argv**, where it would sit
  in the shell history and be visible in `ps` to anything sharing the container. `telegram:test`
  distinguishes *could not reach Telegram at all* from *Telegram answered and rejected us*,
  because collapsing the two is what makes a missing proxy look like a wrong token — and
  from this operator's own country the first is the expected outcome without
  `PANEL_OUTBOUND_PROXY`. Telegram's own error text is never forwarded; the three beginner
  failures (bot never messaged, wrong chat id, revoked token) map to fixed sentences.
- **`npm run restore -- <path>`** — refuses to overwrite a database whose audit chain
  **currently verifies** (a verifying chain is positive evidence the live database is fine,
  and a restore destroys append-only history) and refuses a snapshot whose chain fails at
  its oldest row, since that is what a snapshot written under a different
  `PANEL_MASTER_KEY` looks like. Both are overridable with `--force`; a live write lock is
  not. It takes a consistent safety copy first, swaps through a rename, and removes the old
  `-wal`/`-shm`.

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
  - `PANEL_TRUST_PROXY` (default true) — **leave it on.** Both settings serve and log
    in behind Railway, because the edge sets `Host` as well as `X-Forwarded-Host`, so
    "does it work?" does not distinguish them. Off, the `scheme_downgrade` check is
    silently gone, the recorded client address becomes the container network's, and
    `Host` becomes the only input. On is safe because only the **rightmost** forwarded
    value is honoured and the expected origin never comes from the request.
    `tests/integration/railway-edge.test.ts` drives both.
  - `PANEL_OUTBOUND_PROXY` — an `http(s)://` proxy for **every outbound request**. Not a
    stored secret because it can carry credentials in its userinfo: elided from logs like
    the base path, reported by preflight as set/unset only, and warned about at boot when a
    production panel points it at a non-loopback host (that hop sees the request carrying
    the bot token in its path).
  - `PANEL_NOTIFY_LOCALE` (`en`|`fa`, default `en`) and `PANEL_NOTIFY_INCLUDE_LINKS`
    (default off) — see *Notifications (Telegram)*.
  - `PANEL_WATCHDOG_ENABLED` (default on), `PANEL_WATCHDOG_MEMORY_PERCENT` (85) and
    `PANEL_WATCHDOG_DISK_PERCENT` (80) — see *The resource watchdog*. The clear
    thresholds are **derived** (ten points lower), not configurable: two settable numbers
    can be set the wrong way round, and `clear` above `alert` is a machine that alternates
    on every sample rather than a hysteresis band.
  - `PANEL_LISTEN_HOST` — which address to bind. Defaults to `0.0.0.0` in a container
    (`PANEL_IN_CONTAINER=1`, set by the Dockerfile) or in production, and `127.0.0.1`
    otherwise. The old hard-coded `0.0.0.0` was wrong in both directions: unreachable
    from Railway's edge is not the failure it looks like, and a development server on
    the wildcard is on the LAN with no TLS.

### The container
- Multi-stage `node:22-bookworm-slim` in **both** stages, because `better-sqlite3` is
  compiled in the builder against that image's glibc and Node ABI.
- `npm run build` is `tsc` **plus `scripts/copy-assets.mjs`**. `tsc` emits only what it
  compiles, and the migration runner reads its `.sql` files off disk — a `dist` without
  them boots, prints the base-path banner, and dies with `no such table: audit_log`.
  That was true of every build from M1.1 until M1.6 booted the container.
- `entrypoint.sh` starts as root because Railway mounts the volume root-owned *at
  container start*, so a `chown` in the image is erased by the mount and a process
  already at uid 10001 cannot create `panel.db`. It fixes ownership of the top level and
  the known layout **only where it is wrong** — never `chown -R`, because /data will hold
  project checkouts — then `exec setpriv --reuid --regid --clear-groups --no-new-privs`,
  so node is pid 1 and receives SIGTERM directly. Measured: the no-op pass is 22–30 ms
  and does not move with 20 000 files on the volume; `chown -R` over the same volume is
  170 ms and scales.
- **The drop is permanent and asserted, not assumed.** `setpriv --reuid` sets the saved
  set-user-ID, so `setuid(0)` returns EPERM; `src/server/utils/privileges.ts` proves that
  at boot and refuses to serve either as root or from a reversible drop. Phase 3 spawns
  agent processes as children of this process, which is the whole reason.
- Railway needs `RAILWAY_RUN_UID=0` so the container *starts* as root. The panel still
  never runs as root. If the entrypoint finds itself unprivileged and unable to write the
  volume it refuses to start and names that variable, rather than failing on the first
  write.

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
- **M1.6 — deployment readiness: done.** Part 0 renumbered the notification transport to
  M1.7. Part 1 settled the three points carried over from the M1.5 review: the
  `origin.absent_admitted` audit event, `verify()`'s `wrong_key_or_genesis` hint plus the
  *Key rotation* section in `docs/SECURITY.md`, and the confirmation that the cookie
  `Max-Age` was already asserted three ways. Part 2 replaced the hard-coded listen host,
  rewrote the `Dockerfile` multi-stage on one base image, and added `entrypoint.sh` with a
  non-recursive ownership pass and a permanent `setpriv` drop — and, in the course of
  booting the container for the first time, found that **`npm run build` had never emitted
  `dist/server/migrations/`**, so a built tree ran zero migrations and died on the first
  query. Part 3 replayed Railway's exact header set against the real server under both
  `PANEL_TRUST_PROXY` settings, gave `/healthz` a bounded database read, and put the
  public-origin single-resolver rule behind a static scan. Part 4 added `npm run preflight`,
  `npm run backup`, `npm run restore` and `docs/DEPLOY.md`. Part 5 reconstructed the eleven
  acceptance criteria — they were never in this repository — recorded them in `PLAN.md`, and
  ran them against a running container: 79 checks, 0 failures.
- **M1.7 — notifications and resource metrics: done (API and CLI only, no UI).**
  `GET /api/metrics` with the cgroup v2 readers and the poll-driven sampler
  (`4b3c3bc`), then the outbound Telegram transport (`5a28700`): migration 009's
  `notification_queue` and `notification_state`, the typed-event queue with one worker,
  exponential backoff with jitter, dead-lettering, a boot sweep and a queue cap;
  `notification-rules.ts` exhaustive over `AuditEvent` behind a post-commit
  `AuditObserver`; `notification-render.ts` as the one server-side locale;
  `utils/outbound-http.ts` on undici with `ProxyAgent`; three routes; three CLI commands;
  the `v2` payload AAD with a boot-time upgrade of `v1` rows. **Deferred with reasons:**
  the inbound hook endpoint and its second loopback listener (Phase 3 — there is no agent
  to hook yet, and the two header credentials it needs are specified in `PLAN.md`), the
  resource threshold alerts (a poll-driven sampler cannot observe a crossing while nobody
  polls; they need their own always-on low-cadence watcher — **built in M1.8**), and the
  M2.5 configuration UI.
  `PLAN.md` §*Built in M1.7* — one under the notification design, one under the resource
  design — lists every place the code departs from what was specified.
- **R8 — importing an unfinished project: designed, no code.** `docs/IMPORT.md`, written in
  M1.8, built in M2.8. Two arrival paths (ZIP upload, git clone) with genuinely different
  threat profiles and **one** pipeline from staging onward, enforced by a static scan. Two of
  its decisions land earlier than M2.8 and are the reason it was designed now: migration 011's
  provenance and review columns on `projects`, and four changes to M2.4's settings model — one
  of which corrects M2.4's claim that the operator cannot break the turn-complete notification
  by hand. They can, and so can an uploaded project, because a workspace
  `.claude/settings.json` outranks the user-level file the panel generates.
- **M1.8 — the resource watchdog: done (no UI).** The always-on 30 s watcher, the memory
  and disk crossing rules with derived clear thresholds and a 30-minute cooldown, the
  `oom_kill` counter, and unclean-restart detection through a run marker in `/data/run`;
  migration 010 widening `notification_queue.kind` and adding the crossing state to
  `notification_state`; four new audit events, all with explicit `null` notification rules
  because the watchdog sends better messages than a rule could; `cpuRate()` extracted as a
  pure function so the two consumers of `resources.service.ts` cannot share a sample slot;
  `PANEL_WATCHDOG_ENABLED` / `_MEMORY_PERCENT` / `_DISK_PERCENT` and a preflight section
  that says which rules can actually arm on this machine. `MAX_ATTEMPTS` 12 → 15.
  **Deferred with reasons:** no sustained-CPU rule (see *The resource watchdog*), and no
  route or widget (M2.7 — the watchdog exposes `status()` for it and nothing else).
- **Concurrency: designed, not built.** `PLAN.md` has it, added in M1.6. It answers the
  asymmetry: agents in different projects need nothing beyond the resource cap, while a
  second agent in **one** project gets a git worktree or a `409`, because two agents in one
  working directory is a correctness hazard rather than a capacity one. It also records
  that the panel runs a shell in a pty and is therefore not Claude-specific: only the
  `settings.json` editor and the Stop-hook integration assume Claude Code.
- **M2.0 — Phase 2 architecture: designed, no code**, plus twelve decisions taken after it
  and recorded in `PLAN.md` §*Decisions taken after M2.0* — the export defaults, the
  UUID-collision options, the import caps, the passphrase floor, the provider-credential
  default and the two verified facts behind it, CodeMirror 6 with **no `worker-src` added to
  the CSP**, and the migration numbering. Only the M1.7-tagged ones are built. Seven
  operator requirements arrived after M1.6 and are recorded as **R1–R7** in `PLAN.md`
  (*Phase 2–5 requirements*), which is now the authoritative requirement set: on-demand complete
  backup, panel-to-panel portability, Persian/English bilingual, a per-project file
  browser, per-project `settings.json`, Telegram configuration from the UI, and
  per-project plus global `api_key`/`api_base_url`. `PLAN.md` §*M2 — Phase 2* carries the
  milestone map (M2.0–M2.7), the decisions that block M2.1, the bilingual design and the
  settings/credential design; `docs/PORTABILITY.md` and `docs/FILES.md` are the two new
  specifications. **Three decisions there change Phase 2's shape and must be respected by
  the first component written:** every project carries a UUID and secret AAD is keyed on it
  (not on the row id), workspace directories are named by UUID, and the client is built on
  CSS logical properties with a static scan enforcing it.
- **M2.1 — application shell and design system: not started.** No React, no
  Tailwind, no client code at all yet; `/${basePath}/` serves a placeholder page.
- No terminal or Claude Code integration (Phase 3).

## Next Steps (Phase 2)
See `PLAN.md` §*M2 — Phase 2* for the milestone map and the blocking decisions,
§*Decisions taken after M2.0* for the twelve answers each milestone has to respect, and
§*Decisions taken in M1.8* for six more. In order: the application shell with direction built
in (M2.1), projects with portable identity (M2.2), the file browser (M2.3), settings documents
and provider credentials (M2.4), the Telegram configuration UI — whose transport now exists
(M2.5) — portable export and import (M2.6), the resource widget (M2.7), which has its
endpoint, its poll budget and now `Watchdog.status()` already, and importing an unfinished
project (M2.8, R8 — `docs/IMPORT.md`). Phase 3 remains the terminal, the pty, the Claude Code
integration and the inbound hook endpoint M1.7 deliberately left out.

**Two of R8's decisions are not M2.8's to make.** Migration 011's provenance and review
columns on `projects` land with M2.2, and four changes to the settings model land with M2.4 —
`docs/IMPORT.md` §10 and §11. Both are cheap now and either an `ALTER` against live operator
data or a change to every settings screen later.

**Two things M1.7 leaves for Phase 2 to pick up rather than rediscover.** The client's
metrics poll budget is written down (`PLAN.md`, end of §*Built in M1.7* under the resource
design): two seconds visible, thirty hidden, nothing when the tab is closed — the hidden
cadence is deliberately above the sampler's own and below its idle timeout, so a hidden tab
keeps `cpu.percentOfQuota` a number instead of resetting it to `null`. And the notification
locale is the one place the server holds a human string, so M2.1's translation work must not
grow a second one.

---
*This document will be updated as the project progresses.*