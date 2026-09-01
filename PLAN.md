# Claude Code Control Panel — Phase 1 Plan

## File Tree (target state after Phase 1)

**This is the tree as planned before any of it was written, and it is kept
unedited as the record of that plan.** Where the build diverged, the milestone
entries under [Milestone Order](#milestone-order) say so and are the authority —
notably: `vite.config.ts` was deleted (`fix: restore a working build`; the server
build is `tsc -p tsconfig.build.json` and there is no client to bundle until M2),
`lockout.service.ts` and `lockout.test.ts` do not exist and will not
(no per-IP logic, no lockout), and the M1.4/M1.5 entries list the files that were
added instead. M1.6's files are listed in its own design section below.

```
.
├── CLAUDE.md
├── PLAN.md
├── README.md
├── docs/
│   └── SECURITY.md
├── railway.json
├── Dockerfile
├── .dockerignore
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── eslint.config.js
├── src/
│   ├── server/
│   │   ├── index.ts              # entry: boot checks, fastify, listen
│   │   ├── env.ts                # parse + validate env vars
│   │   ├── crypto.ts             # HKDF, AES-GCM, SecretString, argon2 helpers
│   │   ├── db.ts                 # better-sqlite3 singleton, migration runner
│   │   ├── migrations/
│   │   │   ├── 001_users.sql
│   │   │   ├── 002_sessions.sql
│   │   │   ├── 003_audit.sql
│   │   │   ├── 004_secrets.sql
│   │   │   ├── 005_lockout.sql   # table dropped again by 007 — there is no lockout
│   │   │   ├── 006_secrets_payload.sql
│   │   │   └── 007_auth.sql
│   │   ├── plugins/
│   │   │   ├── security-headers.ts
│   │   │   ├── csrf.ts
│   │   │   ├── rate-limit.ts
│   │   │   ├── auth.ts           # session cookie + step-up decorator
│   │   │   ├── base-path.ts      # prefix routing + generic 404
│   │   │   └── logger-redaction.ts
│   │   ├── routes/
│   │   │   ├── healthz.ts        # outside prefix
│   │   │   ├── auth.ts           # login, logout, setup wizard, TOTP verify
│   │   │   ├── sessions.ts       # list, revoke, revoke-all-others
│   │   │   ├── settings.ts       # global claude profile CRUD
│   │   │   ├── security.ts       # password change, base-path regen, recovery codes
│   │   │   ├── audit.ts          # paginated audit log
│   │   │   └── spa.ts            # catch-all serving index.html with __BASE__ injection
│   │   ├── services/
│   │   │   ├── user.service.ts
│   │   │   ├── session.service.ts
│   │   │   ├── totp.service.ts
│   │   │   ├── lockout.service.ts
│   │   │   ├── audit.service.ts
│   │   │   ├── secrets.service.ts
│   │   │   └── instance.service.ts   # base path, install id
│   │   └── utils/
│   │       ├── timing-safe.ts
│   │       ├── weak-passwords.ts
│   │       └── zod-schemas.ts
│   ├── client/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── router.tsx
│   │   ├── lib/
│   │   │   ├── api.ts            # fetch wrapper with CSRF + base path
│   │   │   ├── auth-context.tsx
│   │   │   ├── toast.tsx
│   │   │   ├── command-palette.tsx
│   │   │   └── use-reduced-motion.ts
│   │   ├── components/
│   │   │   ├── Button.tsx
│   │   │   ├── Input.tsx
│   │   │   ├── Card.tsx
│   │   │   ├── Dialog.tsx
│   │   │   ├── Skeleton.tsx
│   │   │   ├── Tooltip.tsx
│   │   │   ├── Badge.tsx
│   │   │   └── Layout.tsx
│   │   ├── pages/
│   │   │   ├── SetupWizard.tsx
│   │   │   ├── Login.tsx
│   │   │   ├── Projects.tsx
│   │   │   ├── GlobalSettings.tsx
│   │   │   ├── Security.tsx
│   │   │   └── AuditLog.tsx
│   │   └── styles/
│   │       ├── globals.css       # tailwind v4 directives, theme tokens, animations
│   │       └── fonts.css         # self-hosted Inter + JetBrains Mono @font-face
│   └── shared/
│       └── types.ts              # API contract types shared between server/client
├── tests/
│   ├── setup.ts
│   ├── helpers/
│   │   └── test-server.ts        # supertest harness with seeded user
│   ├── unit/
│   │   ├── crypto.test.ts
│   │   ├── secret-string.test.ts
│   │   ├── secrets-repository.test.ts
│   │   ├── timing-safe.test.ts
│   │   ├── lockout.test.ts
│   │   └── totp.test.ts
│   └── integration/
│       ├── auth.test.ts
│       ├── sessions.test.ts
│       ├── csrf-origin.test.ts
│       ├── base-path.test.ts
│       ├── perimeter.test.ts
│       ├── audit.test.ts
│       ├── rate-limit.test.ts
│       └── secret-leak.test.ts   # sentinel secret sweep
└── scripts/
    └── generate-fonts.sh         # downloads Inter + JetBrains Mono woff2
```

## Dependencies

### Production
- `fastify` ^5
- `@fastify/cookie`
- `@fastify/static` ^10       # v10 is the Fastify 5 line; v7 targets Fastify 4
- `@fastify/websocket`
- `better-sqlite3`
- `argon2`
- `otplib` ^13                # RFC 6238 TOTP (upgraded from v12 in M1.4)
- `qrcode`                    # QR for TOTP setup
- `zod`
- `pino` + `pino-pretty`      # structured logging with redaction

### Dev
- `typescript` ^5.7
- `vite` ^6
- `@vitejs/plugin-react`
- `tailwindcss` ^4
- `@tailwindcss/vite`
- `vitest` ^4
- `supertest`
- `@types/better-sqlite3`
- `@types/supertest`
- `eslint` + `@typescript-eslint/*`
- `tsx`                       # dev server runner

### Installed versions (verified on disk, 2026-08-29)

Read back from `node_modules/*/package.json`, not from the range in
`package.json`. `npm audit --omit=dev` reports **0 vulnerabilities** at these
versions.

| Package             | Range in package.json | Installed |
| ------------------- | --------------------- | --------- |
| `fastify`           | `^5.1.0`              | `5.12.1`  |
| `@fastify/static`   | `^10.1.3`             | `10.1.3`  |
| `@fastify/cookie`   | `^11.1.2`             | `11.1.2`  |
| `@fastify/websocket`| `^10.0.1`             | `10.0.1`  |
| `fastify-plugin`    | `^6.0.0`              | `6.0.0`   |
| `vitest`            | `^4.1.11`             | `4.1.11`  |
| `vite`              | `^6.0.11`             | `6.4.3`   |
| `otplib`            | `^13.5.0`             | `13.5.0`  |
| `argon2`            | `^0.41.0`             | `0.41.1`  |
| `better-sqlite3`    | `^11.3.0`             | `11.10.0` |

**Why `@fastify/static` had to move off v7:** v7 depends on `fastify-plugin@^4`,
which encodes a Fastify 4 peer range, so registering it into this project's
Fastify 5 instance fails the plugin version check at boot. v10 depends on
`fastify-plugin@^6` and is developed against `fastify@^5.1.0`. v7 also carries
two open high-severity advisories (GHSA-8pvw-jcv7-9cmj authorization bypass via
non-canonical URL paths, GHSA-83w8-p2f5-377r route-guard bypass via path
traversal) that are only fixed in 10.1.2+.

**v7 → v10 API delta relevant to this project:** none. The default export is
still a Fastify plugin registered as `app.register(fastifyStatic, { root, prefix })`,
and `reply.sendFile()` keeps its signature. v10 adds `serveDotFiles`,
`preCompressed`, and `suppressWarning` options and swaps the internal `send`
implementation for `@fastify/send` v4. Nothing in `src/` imports the package yet
— it is a Phase 2 dependency for serving the built Vite bundle — so there was no
call site to migrate.

## Milestone Order

### M1 — Security Foundation

Delivered as sub-milestones with one commit each, rather than the single commit
this plan originally called for.

- [x] **M1.1 — scaffold and boot** (`feat(m1.1): scaffold and boot`)
      package.json, tsconfig, vite, vitest, eslint; `src/server/env.ts` with
      boot-time self-checks; `/data` layout; `src/server/db.ts` and the numbered
      migration runner.
- [x] **M1.2 — perimeter** (`feat(m1.2): perimeter …`, then
      `fix(m1.2): perimeter review`)
      Secret base path with a constant-time pre-routing gate
      (`src/server/utils/timing-safe.ts`), generic 404, `/healthz`, the full
      response-header set (`plugins/security-headers.ts`), the client bootstrap
      script, and generic error responses.
- [x] **M1.3 — crypto and secret handling** (`feat(m1.3): crypto and secret handling`)
      `src/server/crypto.ts`: HKDF-SHA256 subkeys per purpose, AES-256-GCM with a
      per-write 96-bit nonce and `<table>:<rowId>:<column>` AAD, versioned
      `v1.<nonce>.<ciphertext>.<tag>` payloads, `SecretString`, `mask()`.
      `plugins/logger-redaction.ts` for the pattern-based second line of defence.
      `services/secrets.service.ts` returning `SecretString`.
      Migration `006_secrets_payload.sql`.
- [x] **M1.4 — authentication** (`feat(m1.4): authentication`)
      API only; no UI. argon2id password hashing with the constant-time
      dummy-hash path; two-stage login with a limited `pre` session; mandatory
      TOTP (RFC 6238, replay-protected) and single-use recovery codes; opaque
      server-side sessions with rotation, sliding idle and absolute deadlines;
      step-up re-authentication; the audit log; strict `Origin` validation;
      IP-independent request size limits; migration `007_auth.sql`.

      **Two departures from this plan, both by operator decision, both recorded
      in `CLAUDE.md` and `docs/SECURITY.md`:**

      1. **No per-IP tracking and no lockout, anywhere.** The plan's "progressive
         per-IP and per-account lockout" and "global per-IP token bucket" are
         deliberately not built. The operator connects through tunnels with
         rotating addresses, so per-IP logic penalises the only legitimate user
         while an attacker rotates for free, and an account lockout on a
         single-user panel is a denial-of-service primitive. Replaced by a single
         global consecutive-failure counter driving a target response time, with
         single-flight execution so parallel attempts cannot share one delay
         period. `005_lockout.sql` is left as written and `007_auth.sql` drops the
         table; `tests/integration/no-ip-decisions.test.ts` enforces the property
         statically and behaviourally.
      2. **The double-submit CSRF token is deferred to M2.** ~~It needs a
         non-`HttpOnly` cookie and a header a browser client sets, and there is no
         client yet.~~ **Superseded by M1.5, which built it.** `SameSite=Strict`
         plus strict `Origin` validation were the controls until then, and remain
         the first two of the three.

      `otplib` upgraded 12.0.1 → 13.5.0 as part of this milestone; rationale in
      `CLAUDE.md`. `lockout.service.ts` from the file tree above does not exist;
      `auth-delay.service.ts`, `auth-runtime.ts`, `auth-attempt.ts`,
      `recovery-codes.service.ts`, `instance.service.ts`, `utils/clock.ts`,
      `utils/single-flight.ts`, `utils/client-ip.ts` and `plugins/origin-check.ts`
      do.

- [x] **M1.5 — request integrity and audit** (`fix: make session cookies usable in
      local development`, `fix: restore a working build`,
      `feat(m1.5): request integrity and audit`)
      Two cookie profiles chosen from the effective public origin, because Chrome
      accepts the `Secure` attribute over loopback http but not the `__Secure-`
      *name prefix* and drops the cookie silently; a server-only build, since
      `vite build` was in the Docker script a milestone before any client existed;
      a password change revoking every other session; the session-bound
      double-submit CSRF token (`services/csrf.service.ts`, `plugins/csrf.ts`),
      **no longer deferred to M2** — see the correction below; `Origin`/`Host`
      validation against a configured public origin resolved once in
      `utils/public-origin.ts`; IP-free rate limiting
      (`utils/token-bucket.ts`, `plugins/rate-limit.ts`) plus `bodyLimit` and
      `requestTimeout`; and migration `008_audit_integrity.sql` — append-only
      triggers, an HMAC hash chain with `verify()`, retention writing an
      `audit.trimmed` checkpoint, and the cursor-paged `GET /api/audit` behind a
      full session.

      **Correction to M1.4's second departure.** That entry deferred the CSRF token
      to M2 on the grounds that it needs a header a browser sets and there is no
      browser. The deferral was wrong in one respect: the *mechanism* is testable
      without a browser — `tests/integration/csrf.test.ts` drives it with real
      `curl` against a real listening socket and a real cookie jar — and building it
      now means the M2 client is written against a server that already requires the
      header, rather than having the requirement retrofitted around client code that
      works without it. Nothing is deferred out of M1.5.

- [ ] **M1.6 — notifications** (`feat(m1.6): telegram notifications`)
      Designed but not built. The full design is below under
      *M1.6 — Notifications (Telegram transport): the design*, and the Phase 3
      consumer it exists for is under *Phase 3 preview*. Nothing about it is
      implemented: there is no `notification_queue` table, no migration 009, no
      transport, and no route.

Note: migration 004 created `secrets` with separate `ciphertext`/`nonce` columns.
006 replaces them with a single versioned `payload` column, because separate
columns cannot express the version prefix. 004 is left as-is rather than edited —
a migration that has already run somewhere must never change.

### M1.6 — Notifications (Telegram transport): the design

**Design only. Nothing in this section is built.** Recorded here so the decisions are
made before the code exists, and so the parts that depend on M1.3 crypto and the
M1.5 audit log are pinned to what those modules actually expose today rather than to
what they might be assumed to expose.

Commit when built: `feat(m1.6): telegram notifications`.

#### Why a transport at all, and why Telegram

The panel is a single-user control surface for long-running work. The operator is not
watching it. Two classes of event need to reach a human who is elsewhere: security
events that are already in the audit log (a login failure run, a step-up grant, a
secret revealed), and — from Phase 3 — "Claude Code finished the thing you asked
for". Both are one-way, low-volume, human-read messages, which is the shape Telegram
Bot API fits: no inbound webhook to expose, no SMTP deliverability, no third-party
account beyond the bot, and a client the operator already has on the phone that is
already in their hand.

Nothing about the design is Telegram-specific above the transport seam. The queue,
the redaction pipeline and the alert rules are transport-agnostic; `TelegramTransport`
is one implementation of a `NotificationTransport` interface with a single method,
so a later SMTP or ntfy transport is an added file, not a rewrite.

#### Configuration: two encrypted values, and the AAD they are bound to

The bot token and the destination chat id are both credentials. The token is
obviously one. The chat id is less obviously one and is treated the same way,
because it is the only thing standing between an attacker who has the token and a
delivery address, and because it is a stable identifier for the operator's Telegram
account — it belongs in the same box.

Both go through M1.3 crypto. Neither is ever written to the database in plaintext, to
a log line, to an audit row, or to an HTTP response body — including the response
that reads the configuration back, which returns `mask()`ed forms and a
`configured: boolean`, never the values.

**Storage:** the existing `secrets` table, scope `telegram`, names `bot_token` and
`chat_id`, through `SecretsRepository`, which already returns `SecretString` rather
than a raw string. No new table and no second encryption path — a second path is a
second thing to audit and the sentinel sweep would have to learn about it.

**AAD:** `secrets:telegram:bot_token` and `secrets:telegram:chat_id`.

That is a change to how `SecretsRepository` derives its AAD and it needs stating
plainly, because the repository today uses `columnAad('secrets', id, 'payload')` —
`secrets:<rowId>:payload`. The row-id form binds a ciphertext to the row it was
written into, so it cannot be moved between rows; it does **not** bind the row's
logical identity, so an attacker with write access to `panel.db` can rename a row's
`scope`/`name` and the ciphertext still decrypts. Applied here that is not
theoretical: swap the `bot_token` and `chat_id` labels and the panel puts the bot
token into the `chat_id` query parameter of an outbound request to
`api.telegram.org`. The request fails Telegram's own auth, and the token has still
left the building.

`UNIQUE (scope, name)` in migration 006 is what makes the fix free: since at most one
row can hold a given `(scope, name)`, an AAD of `columnAad('secrets', scope, name)`
is at least as strong as the row-id form and strictly stronger against relabelling.
So:

- New writes use payload version `v2` with AAD `secrets:<scope>:<name>`. `v1` rows
  keep decrypting under `secrets:<id>:payload`. The version prefix from M1.3 exists
  precisely so this does not have to be guessed at, and `decrypt()` already rejects
  an unknown version rather than assuming a layout.
- No re-encryption migration is needed today: M1.3 is the first and only writer to
  `secrets`, and no endpoint writes one yet, so on every existing install the table
  is empty. Migration 009 asserts that rather than trusting it — if a `v1` row does
  exist it is re-encrypted as `v2` inside the migration transaction.
- **The AAD must be injective over `(scope, name)`.** `columnAad` validates that
  *table* and *column* contain no `:`, but `rowId` is `string | number` and is not
  checked, and project-scoped secrets use `scope = 'project:<id>'`. Without a rule,
  `('project:7', 'x')` and `('project', '7:x')` produce the same AAD. The rule is
  that `name` may not contain `:`; a unit test asserts the collision is rejected
  rather than merely unlikely. An AAD is only ever compared byte-for-byte, never
  parsed, so injectivity is the whole requirement.

**Reading the token to send with is the only place it is decrypted**, immediately
before the request, and the revealed string is never assigned to anything that
outlives the call. It goes into the URL path (`/bot<token>/sendMessage`), which is
where Telegram puts it, which means the URL itself is a secret and must never be
logged — the transport logs `telegram sendMessage` and a status code, never a URL.

#### Writing the configuration

`POST /api/notifications/telegram` — full session **and step-up**, same as revealing
or writing any other stored secret. Body `{botToken, chatId}`. It writes both
secrets, then enqueues a verification message and answers `{ok: true, queued: <id>}`
without waiting for delivery. An `AuditEvent.NotificationConfigChanged` row records
that the configuration changed and **which fields** changed, never the values.

`GET /api/notifications/telegram` — full session, no step-up. Returns
`{configured, chatIdMasked, tokenMasked, lastSuccessAt, lastFailure}` where
`lastFailure` carries a category and a timestamp, not a response body — Telegram's
error payloads echo request parameters.

`POST /api/notifications/test` — full session, no step-up. Enqueues a fixed test
message. Answers `202` with the queue row id; the operator polls
`GET /api/notifications/queue/:id` for the outcome, or just looks at their phone.
Deliberately not synchronous: a synchronous send makes the panel's response time a
function of a third party's availability, and the whole point of the queue is that
nothing in the request path ever waits on `api.telegram.org`.

#### The queue: persisted, asynchronous, and unable to take the panel down

Migration 009 adds `notification_queue`:

| column | meaning |
| :--- | :--- |
| `id` | INTEGER PRIMARY KEY |
| `created_at` | when enqueued |
| `kind` | `alert` \| `test` \| `turn_complete` — routes formatting, not transport |
| `title` | short line, already redacted at enqueue time |
| `body` | long text, already redacted at enqueue time, may exceed the wire cap |
| `state` | `pending` \| `sending` \| `sent` \| `failed` \| `abandoned` |
| `attempts` | INTEGER NOT NULL DEFAULT 0 |
| `next_attempt_at` | when the worker may next pick it up |
| `last_error` | a category string, never a response body |
| `sent_at` | set on success |

Four properties, each of which the implementation has to be built around rather than
retrofitted:

1. **Enqueue is synchronous and local; sending never is.** `notify()` is a plain
   `INSERT` inside whatever transaction the caller is already in, and it returns.
   No `await` on a socket, no `fetch` in a request handler, no floating promise. A
   caller can enqueue from inside an audit write and be certain that the worst a
   broken Telegram configuration can do to that request is nothing at all.
2. **Redaction happens at enqueue, not at send.** The `title` and `body` stored in
   the row are already through the M1.3 secret redaction and the M1.2 base-path
   elision, so the database never holds an un-elided copy either. Redacting at send
   time would leave the base path sitting in `notification_queue` — a table that,
   unlike a log line, persists on the volume.
3. **Exponential backoff with a ceiling and an abandonment point.** Delays
   `2^attempts` seconds from 1 s, capped at 15 minutes, jittered ±20 % so a burst
   enqueued together does not retry in lockstep. After 12 attempts — a little over
   two hours of trying — the row goes to `abandoned` and stays in the table.
   Abandoned is not deleted: "the panel tried to tell you and could not" is itself
   information, and the queue is the only place it exists.
4. **The worker is a single timer, and it is the only thing that reads the token.**
   One `setTimeout` chain, not one per row; it wakes, claims the oldest due row with
   `UPDATE … SET state='sending' WHERE id=? AND state='pending'` and checks
   `changes === 1` so two workers can never claim the same row, sends, records the
   outcome, and re-arms. It never throws out of itself: the entire body is wrapped,
   and a failure to even *read* the configuration is recorded as
   `last_error = 'not_configured'` and backed off like any other failure. A panel
   with no Telegram configuration accumulates rows and sends nothing; it does not
   error, and it does not lose them — configure it later and the backlog drains.

Startup drains what is due. A row left in `sending` by a crash is reclaimed on boot
(`state='sending' AND next_attempt_at < now` → `pending`), which risks a duplicate
message and never a lost one; for a notification that is the right way round.

#### The 4096-character cap

Telegram's `sendMessage` limit is 4096 characters and it rejects the whole request
rather than truncating. Anything long — a Claude Code turn summary, an audit
excerpt — will hit it.

Both halves, in this order:

1. Send `sendMessage` with the text truncated to 4096 characters, counted in
   **code points and not UTF-16 units**, ending in a marker line
   `— truncated, full text attached (N characters)`. Truncation happens at a
   character boundary and, where one exists within the last 200 characters, at a
   newline, so the cut does not land mid-word.
2. Then send the full text as a document via `sendDocument`, `multipart/form-data`,
   filename `<kind>-<queue-id>.txt`, `text/plain; charset=utf-8`.

The document is a *second* request and is allowed to fail on its own. If the message
succeeds and the document fails, the row is `sent` and the document failure is a
logged warning: the operator has the readable part, and blocking on the attachment
would re-send the truncated message on the next attempt. This asymmetry is the
reason the two are separate steps rather than one atomic "delivery".

#### Outbound proxy for local development

This machine's environment sets `http_proxy`/`https_proxy`, and Node 18+ `fetch`
ignores both by default. Rather than depend on a global, the transport takes an
optional `PANEL_OUTBOUND_PROXY` and, when set, dispatches through an
`undici.ProxyAgent`. Unset means a direct connection. It is read in `env.ts` with
everything else, validated as a URL, and — because a proxy URL can carry
credentials — never logged.

Two guards that are cheap now and awkward later: the proxy is only consulted for
outbound transport requests, never for anything else the panel does; and a proxy
URL with a non-loopback host in production is a boot warning, since a production
panel routing its notifications through an unexpected hop is more likely a mistake
than a plan.

#### Which events raise an alert

Alerts are derived from audit events that already exist, in one place —
`notification-rules.ts` mapping `AuditEvent` to an optional
`{title, body, throttleKey}`. Not scattered through the handlers, so the answer to
"what does this panel tell me about?" is a single readable file, and so an event can
never be *silently* unmonitored: the map is exhaustive over `AuditEvent`, and a new
event that has no rule must say `null` explicitly.

Notify on: `login.success` (this panel has exactly one legitimate user, so a
successful login the operator did not perform is the single most valuable alert it
can send), `login.failure` and `totp.failure` (throttled — see below),
`recovery_code.used`, `password.changed`, `stepup.granted`, `two_factor.disabled`,
`recovery_codes.regenerated`, `secret.revealed`, `secret.changed`,
`base_path.regenerated`, `audit.trimmed`, and `setup.completed`.

Silent by design: `session.created` and `session.revoked` (implied by the login and
the revocation that caused them), `auth.delay_applied` (the delay is the
interesting part and the failure row already carries it),
`two_factor.enrollment_started` (its completion is what matters).

**Throttling is per rule and per window, and it counts.** A password-spray run
produces one `login.failure` per attempt; forwarding each one turns the notification
channel into the attack's amplifier and the operator's phone into the thing that
gets denied service. Each `throttleKey` sends at most one message per 15 minutes and
the message carries the count suppressed in that window
(`14 further failures in the last 15 minutes`). The count comes from the audit log,
which is the authority, not from an in-memory tally that a restart would lose.

#### Never a secret in the message, and never the base path

Three layers, in the order they apply:

1. The rule builds the message from fixed shapes and named audit metadata fields.
   It never interpolates a whole `meta_json`, because that is how an unexpected
   field ends up on the wire.
2. Every `title` and `body` goes through the same redactor the logger uses, plus
   base-path elision, **at enqueue time**.
3. `SecretString` is the real control, exactly as in M1.3: a revealed secret is
   never a string in the first place, so it cannot be interpolated by accident. A
   test asserts that passing a `SecretString` to `notify()` throws rather than
   redacts — the same stance as `meta_json` validation, and for the same reason:
   it is a bug in our code, not untrusted input to be laundered.

#### Tests to write

- Queue: enqueue inside a transaction does not touch the network; a claim race
  between two workers yields one send; backoff schedule matches the table above;
  a `sending` row left by a crash is reclaimed on boot.
- Transport: a 4097-character body produces exactly two outbound requests, the
  first truncated at a code-point boundary with the marker, the second a document;
  a failing document leaves the row `sent`; a 429 from Telegram backs off and does
  not abandon.
- Redaction: a body containing the base path is elided in the stored row, not just
  on the wire; a `SecretString` passed to `notify()` throws.
- Rules: the map is exhaustive over `AuditEvent` (a compile-time `Record<AuditEvent,
  Rule | null>` plus a runtime assertion); throttling emits one message and a
  suppressed count read back from the audit log.
- Crypto: `secrets:telegram:bot_token` is the AAD actually used, proven by
  decrypting with it directly; a `v1` row still decrypts; `name` containing `:` is
  rejected.
- Endpoints: `POST /api/notifications/telegram` without step-up is 403; the `GET`
  never returns either value in any form other than `mask()`; a static scan asserts
  no file outside `telegram.transport.ts` names `api.telegram.org`.

#### Files

`src/server/services/notify.service.ts` (queue and `notify()`),
`src/server/services/telegram.transport.ts`,
`src/server/services/notification-rules.ts`,
`src/server/routes/notifications.ts`,
`src/server/migrations/009_notifications.sql`, `tests/unit/notify.test.ts`,
`tests/unit/telegram-transport.test.ts`,
`tests/integration/notifications.test.ts`.

### M2 — Application Shell & Design System
1. Tailwind v4 theme: colors, spacing, font stacks, animation keyframes in
   `globals.css`. Self-host fonts via `fonts.css`.
2. Primitive components: Button, Input, Card, Dialog, Skeleton, Tooltip, Badge,
   Layout. All keyboard-accessible, focus-visible rings, ARIA.
3. Client lib: api fetch wrapper (CSRF token, base path), auth context, toast
   system, command palette, reduced-motion hook.
4. Pages: SetupWizard, Login, Projects (empty state), GlobalSettings, Security,
   AuditLog.
5. Router with basename from `window.__BASE__`, SPA catch-all injection verified.
6. Visual polish: dark/light themes, page transitions, skeleton loaders, tooltips.
7. Accessibility pass: focus traps, escape key, ARIA roles, Lighthouse ≥ 95.
8. End-to-end smoke: hard refresh on deep route, CSP-clean console, reduced motion.
9. **Commit:** `feat(m2): application shell and design system`

### Post-M2
- Write `docs/SECURITY.md` mapping table.
- Write `Dockerfile` + `railway.json` + `README.md` env-var section.
- Final verification against all 11 acceptance criteria.
- Update `CLAUDE.md` with Phase 1 decisions and Phase 2 handoff notes.
- **Commit:** `docs: phase 1 completion and deployment artifacts`

## Phase 3 preview — "Claude Code finished" notifications

**Design only, and out of Phase 1 scope. Nothing here is built.** It is recorded now
because it is the reason M1.6 exists, and because two of its decisions constrain
M1.6's shape: the transport must accept an enqueue from a route that has no session,
and the queue must be the thing that answers, not the network.

Depends on M1.6 for delivery.

### Not terminal parsing

Phase 3 attaches a terminal to a Claude Code process over a WebSocket. The tempting
implementation is to watch that stream for a prompt returning and call it "finished".
It is the wrong mechanism: it couples the panel to Claude Code's rendering, it cannot
distinguish "finished the task" from "asked a question and is waiting", it breaks on
any change to the CLI's output, and it produces false positives on every partial
redraw. Claude Code publishes an event for exactly this, and the event is authoritative
about a thing the terminal only implies.

### The hook reference, verified

Checked against `https://code.claude.com/docs/en/hooks` on **2026-09-02**
(`https://docs.claude.com/en/docs/claude-code/hooks` 301-redirects there; the raw
markdown is at the same path with a `.md` suffix, which is the copy to re-read before
implementing). Everything in this section is from that fetch, not from memory. The
facts the design leans on:

- **`Stop` fires when the main agent has finished responding.** It does not fire on a
  user interrupt, and an API error fires `StopFailure` instead. `Stop` has **no
  matcher support**, and a `Stop` hook declared in subagent frontmatter is rewritten
  to `SubagentStop`.
- **Input fields on `Stop`:** the common set — `session_id`, `transcript_path`,
  `cwd`, `permission_mode`, `hook_event_name` — plus `stop_hook_active`,
  `last_assistant_message`, `background_tasks` and `session_crons`. Newer versions
  add `prompt_id`. `cwd` follows worktrees and `cd`.
- **`last_assistant_message` carries the text of Claude's final response, and the
  docs direct notification hooks to use it**: *"For hooks that act on the
  just-completed turn, such as read-aloud or notification hooks, use this field
  rather than reading `transcript_path`: the transcript file isn't guaranteed to
  include the final message at Stop time on all versions."* This inverts the
  fallback: the transcript is the unreliable path, not the safe one.
- **`stop_hook_active` is `true` when Claude Code is already continuing because of a
  stop hook.** Claude Code also overrides the hook and ends the turn after 8
  consecutive blocks.
- **Blocking on `Stop`:** exit code 2 "prevents Claude from stopping, continues the
  conversation", with stderr delivered as the reason. In JSON, `decision: "block"`
  plus a required `reason` does the same, and `hookSpecificOutput.additionalContext`
  continues the conversation more politely. A universal `continue: false` stops
  Claude entirely and takes precedence over event-specific fields.
- **HTTP hooks (`type: "http"`) POST the identical JSON with
  `Content-Type: application/json`**, and — this is the part that decides the
  transport — the response is interpreted as follows: *2xx with an empty body* is
  success equivalent to exit 0 with no output; *2xx with a JSON object* is parsed
  under the same schema as command stdout; *2xx with any other body* is a
  **non-blocking** error; *non-2xx* is a **non-blocking** error, execution
  continues; *connection failure* is a **non-blocking** error, execution continues;
  a timeout cancels the hook and discards its output. Explicitly: *"HTTP hooks can't
  signal a blocking error through status codes alone."*
- **`timeout` is in seconds and defaults to 600 for `command`, `http` and
  `mcp_tool`** on `Stop` (it is only lowered on `UserPromptSubmit`,
  `PreModelSwitch`, `PostModelSwitch` and `MessageDisplay`). A cancelled hook
  renders no decision.
- **`async: true` is a `command`-hook field only.** An async hook cannot block or
  control Claude — `decision`, `permissionDecision` and `continue` have no effect —
  and its `timeout` is not enforced. `asyncRewake` is the exception that keeps exit
  code 2 meaningful, waking Claude on a background failure.
- **HTTP hook config fields:** `url` (required), `headers` (values interpolate
  `$VAR` / `${VAR}` **only** for names listed in `allowedEnvVars`), and
  `allowedEnvVars`. Two settings gates exist at every level including managed
  policy: `allowedHttpHookUrls`, which when defined anywhere restricts which hook
  URLs run at all, and `httpHookAllowedEnvVars`.

### Transport: an HTTP hook to a loopback endpoint

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:<port>/internal/hooks/stop",
            "timeout": 5,
            "headers": { "Authorization": "Bearer $CC_PANEL_HOOK_TOKEN" },
            "allowedEnvVars": ["CC_PANEL_HOOK_TOKEN"]
          }
        ]
      }
    ]
  }
}
```

Written by the panel into the project's `.claude/settings.json` when the project is
created, with `CC_PANEL_HOOK_TOKEN` injected into the Claude Code process
environment — a **per-project** token, generated at project creation, stored
encrypted under AAD `secrets:project:<id>:hook_token`, so a token leaked from one
project's environment cannot report turns for another. The token never appears in
the settings file; only the variable name does, which is what `allowedEnvVars` is
for.

The HTTP hook is preferred over a command hook invoking `curl` for three reasons,
all now verified rather than assumed:

1. **It cannot accidentally block.** A command hook that exits 2 — a `curl` that
   fails, a shell that cannot find it, a script with a typo — *prevents Claude from
   stopping and continues the conversation*. There is no status code an HTTP hook
   can return that does that; blocking requires a deliberate 2xx JSON body with
   `decision: "block"`. The panel's endpoint answers `204 No Content`, which the
   docs define as "success, equivalent to exit code 0 with no output". The failure
   mode of the panel being down is *non-blocking error, execution continues*.
2. **No shell.** No quoting of `last_assistant_message` into a command line, no
   `$(...)`, no dependency on `curl`, `jq` or a profile that prints a banner on
   startup.
3. **One fewer process per turn**, and the token stays in an environment variable
   the panel controls rather than in an argv the process table shows.

**The command-hook fallback**, for a Claude Code build without HTTP hooks or an
environment where `allowedHttpHookUrls` forbids the URL:
`{"type": "command", "command": ".claude/hooks/notify-panel.sh", "async": true,
"timeout": 5}`. `async: true` makes it structurally unable to block — the docs are
explicit that an async hook's `decision` and `continue` have no effect — and the
script must still `exit 0` unconditionally: `curl --max-time 3 … >/dev/null 2>&1 ||
true` followed by `exit 0`, with no `set -e`. A Stop hook that exits 2 makes Claude
keep working, which is the worst outcome available: the panel's monitoring would be
driving the agent.

**`timeout` is set explicitly to 5 seconds and that is not cosmetic.** `async` is
not available on HTTP hooks, so the Stop hook *is* synchronous, and the default is
600 seconds. A panel that accepted the POST and then blocked on `api.telegram.org`
would hold the end of every turn for as long as Telegram was slow. This is the
requirement that makes M1.6's persisted queue mandatory rather than merely tidy: the
endpoint validates, enqueues, and returns `204` in single-digit milliseconds, and the
worker deals with the network afterwards.

### The endpoint

`POST /internal/hooks/stop`, and it is deliberately unlike every other route in this
panel:

- **Bound to loopback only**, on a second Fastify listener on `127.0.0.1` — not the
  public listener with a path check. A path-based split means one bad `rewriteUrl`
  or proxy rule away from being reachable from the internet; a separate listener
  cannot be reached from off-host at all. It is also **outside the secret base
  path**, like `/healthz`, because the hook config would otherwise embed the base
  path in a file inside the project directory.
- **It must not accept a session cookie.** No `attachSession`, no CSRF hook, no
  session lookup — the only credential is the bearer token, compared with
  `timingSafeEqual`. A cookie-authenticated endpoint reachable from a process
  running on the same host is a confused-deputy hole: anything on the box that can
  make an HTTP request would inherit the operator's session. For the same reason it
  is not registered under the `/api` prefix, so it cannot inherit that scope's
  hooks by accident — see the Fastify encapsulation precedent in `CLAUDE.md`.
- **Rate limited on its own bucket**, keyed on the project the token resolves to,
  independent of the anonymous and session buckets from M1.5.
- `bodyLimit` well above the API's 64 KiB, because `last_assistant_message` is
  a whole model response. 1 MiB, and a body over it is a `413` that the hook treats
  as a non-blocking error — a truncated notification is not worth a special case.
- Answers `204` on success, `401` on a bad token, `204` on a payload it decides to
  ignore. **A skipped notification is a success, not an error**, because the only
  consumer is a hook whose error handling ends in a notice on the operator's
  terminal that they cannot act on.

### What it does with the payload

1. **`stop_hook_active === true` → return `204` immediately**, before anything else.
   The turn is a continuation driven by a stop hook, not a finish.
2. **Resolve the project from `cwd`.** Longest-prefix match against the known
   project roots, since `cwd` follows `cd` and worktrees and may be a subdirectory.
   No match → `204` and a debug log line; an unmapped directory is not an error.
3. **Duration gate.** Notify only if the turn took longer than
   `PANEL_NOTIFY_MIN_TURN_SECONDS`, default **60**. Below that the operator is
   almost certainly still watching, and a phone buzzing on every three-second
   exchange trains them to ignore it. Turn start is taken from the panel's own
   record — the terminal session's last input timestamp for that `session_id` —
   because the Stop payload carries no start time and the transcript's timestamps
   are the unreliable path.
4. **Message body: `last_assistant_message` when present.** When it is absent
   (older builds), fall back to reading the last assistant entry from
   `transcript_path` — **with a staleness guard**: accept it only if its timestamp
   is at or after the recorded turn start, and otherwise send the notification with
   no body at all. The docs warn the transcript may not contain the final message
   yet at `Stop` time, and the failure mode of ignoring that is worse than a missing
   body: the panel would report the *previous* turn's answer as this turn's result.
   `transcript_path` is opened read-only, with a size cap, and only the tail is
   parsed.
5. **Also worth a look, and cheap:** `background_tasks` and `session_crons`. Both
   arrays are present when the task registry is reachable. A "finished" message
   while three shell tasks are still running is misleading, so the message says so
   (`3 background tasks still running`) rather than suppressing the notification.
6. **Enqueue and return `204`.** `notify({kind: 'turn_complete', …})`. Nothing here
   awaits the transport.

The response body is empty on every path. Not `{}`, not `{"ok":true}` — a 2xx with a
non-JSON body is a non-blocking error, and a 2xx with a JSON object is parsed as a
decision. `204` with no body is the only shape that says nothing at all, and saying
nothing is the entire contract.

### Open questions to settle before building

- Whether `.claude/settings.json` written by the panel is respected without the
  operator approving the hook interactively; if approval is required, the project
  creation flow has to surface it.
- Whether `allowedHttpHookUrls` is set in the container's managed policy; if so the
  loopback URL has to be added there too.
- Whether the panel's own port is stable enough to hard-code into each project's
  settings file, or whether the hook URL should be written at spawn time from the
  live port.

## Phase 1 Exit Checklist
- [ ] Docker build verified, container boots as uid 10001 with an empty volume

**This checklist is truncated, and it has been truncated since the plan was
written** — the committed file ended mid-list with a stray `</content>` tag, now
removed. The "11 acceptance criteria" that Post-M2 says to verify against are not
recorded in this repository or in any other file under it, so there is nothing to
restore the remaining items from. Left as a flagged gap rather than filled in with
invented criteria: whatever the eleven were, they need writing down before Phase 1
can be called finished, and the honest state of this checklist is *unknown*, not
*one item*.
