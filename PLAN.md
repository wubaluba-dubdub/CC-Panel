# Claude Code Control Panel — Phase 1 Plan

## File Tree (target state after Phase 1)

**This is the tree as planned before any of it was written, and it is kept
unedited as the record of that plan.** Where the build diverged, the milestone
entries under [Milestone Order](#milestone-order) say so and are the authority —
notably: `vite.config.ts` was deleted (`fix: restore a working build`; the server
build is `tsc -p tsconfig.build.json` and there is no client to bundle until M2),
`lockout.service.ts` and `lockout.test.ts` do not exist and will not
(no per-IP logic, no lockout), and the M1.4/M1.5 entries list the files that were
added instead. M1.6 added the deployment artefacts this tree never listed
(`entrypoint.sh`, `.gitattributes`, `src/server/cli/*`, `docs/DEPLOY.md`) alongside
the `Dockerfile` and `railway.json` it did. M1.7's files are listed in its own
design section below.

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

- [x] **M1.6 — deployment readiness** (`feat(m1.6): …`, one commit per part)
      The Phase 1 exit: make the container build, boot on a real volume, and survive
      behind Railway's edge. No new product features. What it added, and why each
      piece could only be settled with a real container rather than a unit test:

      - **Renumbering.** The Telegram transport was M1.6 and is now M1.7; this is
        M1.6. Eleven references moved.
      - **Three decisions carried over from the M1.5 review.** An admitted mutating
        request with a session cookie and *no* `Origin` header now writes
        `origin.absent_admitted` — the behaviour is unchanged and still correct, but
        it is no longer silent. `verify()` distinguishes a chain that fails from its
        oldest surviving row (`hint: 'wrong_key_or_genesis'`) from one that breaks
        partway, because a wrong `PANEL_MASTER_KEY` fails at row 1 on a completely
        untampered log and an operator must not be trained to read that as a tamper.
        The session cookie's `Max-Age` was already asserted at every level; the
        entry below names the tests rather than adding more.
      - **The listen host.** `0.0.0.0` was hard-coded. It is now resolved by
        `resolveListenHost`, `0.0.0.0` in a container or in production and
        `127.0.0.1` for local development, because a development server on the
        wildcard is reachable from the LAN and nothing said so.
      - **The container.** Multi-stage `node:22-bookworm-slim` — the *same* base in
        both stages, so the `better-sqlite3` binary compiled in the builder is valid
        in the runtime — plus `entrypoint.sh`, which is the part that matters:
        Railway mounts the volume at container *start*, root-owned, so a `chown` in
        the image is erased by the mount and a process already running as uid 10001
        cannot create `panel.db`. The entrypoint starts as root, fixes ownership of
        the top level and the known subdirectories **only when it is wrong**, and
        `exec setpriv`s to 10001 so the server is pid 1 and cannot regain root.
      - **Behind the edge.** Railway's header set replayed against the real server,
        with a client-supplied `X-Forwarded-Host: evil.example` in front of the real
        value, with `PANEL_TRUST_PROXY` both on and off.
      - **Operator tooling.** `npm run preflight`, `npm run backup`,
        `npm run restore`, and `docs/DEPLOY.md` written for someone who has never
        deployed anything.
      - **The eleven acceptance criteria, written down at last.** They were never
        recorded in this repository — see the note under *Phase 1 Exit Checklist* —
        so this milestone reconstructed them from the security model and ran them
        against the running container. They are now in that checklist.

- [ ] **M1.7 — notifications** (`feat(m1.7): telegram notifications`)
      Designed but not built. The full design is below under
      *M1.7 — Notifications (Telegram transport): the design*, and the Phase 3
      consumer it exists for is under *Phase 3 preview*. Nothing about it is
      implemented: there is no `notification_queue` table, no migration 009, no
      transport, and no route.

Note: migration 004 created `secrets` with separate `ciphertext`/`nonce` columns.
006 replaces them with a single versioned `payload` column, because separate
columns cannot express the version prefix. 004 is left as-is rather than edited —
a migration that has already run somewhere must never change.

### M1.7 — Notifications (Telegram transport): the design

**Design only. Nothing in this section is built.** Recorded here so the decisions are
made before the code exists, and so the parts that depend on M1.3 crypto and the
M1.5 audit log are pinned to what those modules actually expose today rather than to
what they might be assumed to expose.

Commit when built: `feat(m1.7): telegram notifications`.

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

#### The inbound hook endpoint's credentials: two of them, both configurable

**Added after the M1.6 review; this supersedes the single-bearer-token sketch under
[Phase 3 preview](#the-endpoint).** The endpoint is `POST /internal/hooks/stop`, bound to
loopback on its own listener, and it is the one route in this panel that authenticates
with headers instead of a session. Two independent header credentials are required, and
both must be present and correct:

| header | value | scope |
| :--- | :--- | :--- |
| `Authorization: Bearer <token>` | a **per-project** token, generated when the project is created | one project |
| `X-Panel-Hook-Secret: <secret>` | a **panel-wide** shared secret, generated at first configuration | every project |

**Why two rather than one.** A single per-project token is a single string that has to
live in a process environment the panel does not fully control — Phase 3 injects it into
an agent process, and that process runs a shell, reads files, and executes whatever the
operator asked for. A token that leaks out of one project's environment (an `env` dump in
a transcript, a `.env` written into a repository, a hook script echoing its own
configuration) would otherwise be complete authority to report turns. Requiring a second,
independent secret that is **not** per-project means a leaked project token alone is not
sufficient — and requiring the per-project token means the panel-wide secret alone is not
sufficient either. Neither half is useful without the other, which is the same shape as
the backup-and-key rule in `docs/DEPLOY.md`.

Both are credentials and are treated exactly like the Telegram token:

- stored through `SecretsRepository` with the M1.3 crypto module — the project token under
  AAD `secrets:project:<id>:hook_token`, the shared secret under
  `secrets:hook:shared_secret` (both `v2`, `(scope, name)`-bound, per the AAD change above);
- **rotatable from the UI**, independently, each rotation writing an audit row that names
  which credential rotated and never its value. Rotating the shared secret invalidates
  every project's hook at once and therefore has to rewrite every project's
  `.claude/settings.json` environment — which is a reason to make that a deliberate,
  confirmed action rather than a button;
- compared with `timingSafeEqual` after a length check, never with `===`;
- **never written to a log line, an audit row, or a response body.** The endpoint logs
  `hook rejected` and a category, and nothing else. `SecretString` is the control, as
  everywhere else.

**Failure behaviour, which is the part that has to be specified rather than left to the
implementation.** The endpoint answers **identically** for a bad bearer token, a bad
shared secret, and a token that resolves to no project: the same status, the same empty
body, and the same shape of work done before answering. An attacker on the host probing
the endpoint must not be able to tell "this token is for a project that exists" from
"this token is meaningless", because the first is a much smaller search space than the
second.

- Status: **`401` with an empty body.** Not `403` and not `404`. (A *successful* hook
  answers `204`; see the Phase 3 preview for why the success shape is `204` and not
  `200 {}`.)
- Both credentials are compared **every time**, even when the first has already failed, so
  the response time does not reveal which one was wrong.
- The project lookup happens **after** the shared-secret check and its result does not
  branch the response.
- **Its own rate-limit bucket**, keyed on nothing — the same reasoning as the anonymous
  bucket in M1.5, since a failing request has no identity that can be trusted. Separate
  from the anonymous and per-session buckets so a misconfigured hook cannot spend the
  operator's tokens, and so a flood here cannot lock the operator out of the panel.
- **Every rejection is an audit row**, `hook.rejected`, with the failure *category* only
  (`bad_bearer`, `bad_shared_secret`, `unknown_project`, `rate_limited`) and never the
  presented value. The category is safe in the log precisely because it is not in the
  response.

#### If the bot is ever given a webhook

Two-way control — replying to a notification to steer an agent — is **not in scope** and
is not being designed here. But it should not be designed *out*, so the mechanism is
recorded now.

Telegram's `setWebhook` accepts a **`secret_token`** parameter (1–256 characters,
`A-Z a-z 0-9 _ -`). Telegram then sends that value back in an
**`X-Telegram-Bot-Api-Secret-Token`** header on every callback request. That is the
mechanism to use: it is Telegram's own answer to "is this request really from Telegram",
and it needs no allowlist of source addresses. Store it like any other credential,
compare it in constant time, and reject a callback without it before reading the body.

**The far more important control is an allowlist of permitted `chat_id` values, and it is
more important because the threat is different.** The secret token proves a request came
from Telegram. It says nothing about *who* talked to the bot. Anyone who learns the bot's
username can message it — bot usernames are discoverable, and Telegram will happily
deliver a stranger's message to the webhook with a valid secret token attached. So:

- the panel keeps an explicit allowlist of `chat_id` values (in practice the operator's
  own, the one already stored as a credential);
- **the allowlist check comes before any parsing of the message body** — before command
  extraction, before argument parsing, before anything that could be influenced by
  attacker-controlled text. An unlisted chat is dropped, counted, and audited as
  `hook.rejected` with category `chat_not_allowed`;
- the reply is silence, not an error message. Telling a stranger "you are not authorised"
  confirms the bot is a control surface for something.

Ordering matters and is the whole point of writing it down: secret token, then chat
allowlist, then parse. A design that parses first to find the `chat_id` has already
handed untrusted input to a parser.

#### The completion message: what it says, in what order

Concretely, and in this order:

```
<project name> — <outcome>
<duration>

<last assistant message, truncated>

<link into the panel at that project>          ← only under the conditions below
```

For example:

```
acme-web — finished
4m 12s

Added the retry wrapper around the upload call and a test for the 429 path.
Two files changed; the suite passes.

https://panel.example.com/<base>/projects/7
```

- **The project name comes first**, because the operator has several and the first line is
  all a phone notification shows. Every message names its project; there is no
  "unattributed" shape.
- **The outcome** is one of `finished`, `finished, with N background tasks still running`,
  `stopped early`, or `failed`. Derived from the Stop payload, never from parsing the
  terminal.
- **The duration** is from the panel's own record of the turn's start, not from the
  transcript's timestamps — see the Phase 3 preview for why the transcript is the
  unreliable source.
- **The truncated last assistant message**, from `last_assistant_message`, through the
  same redaction and base-path elision as everything else, at enqueue time.

**The link, and the decision it forces.** The project *name* is not a secret: the operator
chose it, it is not a credential, and a notification that will not say which project it is
about is not worth sending. **The base path inside the link is a secret**, and it is the
whole obscurity layer. A Telegram message is stored on Telegram's servers, is readable by
anyone who gets at the operator's phone or their Telegram account, and is synced to every
device they have ever logged in from. Putting the base path there is a permanent
disclosure to a place the panel does not control.

So the link is **off by default**, behind a single setting
`PANEL_NOTIFY_INCLUDE_LINKS` (default `false`):

- **`false` (default):** the message ends after the truncated text. It names the project
  and says what happened, which is everything the operator needs to decide whether to go
  and look.
- **`true`:** the message ends with a deep link including the base path. The setting's
  description in the UI says, in those words, that turning it on writes the panel's secret
  URL into every notification and into Telegram's storage, and that the base path should
  be rotated if the Telegram account is ever compromised.

There is no middle option, and that is deliberate. A "link without the base path" is a URL
that 404s, and a short-lived signed link would be a second authentication path into the
panel — reachable from a chat message, bypassing the session — which is a considerably
worse idea than a link the operator has to paste.

#### The queue carries a typed event, not a rendered string

`notify()` takes a **typed event**, and the rendering happens inside the notification
layer. The Phase 3 `Stop` hook is the first producer but not the only one: the
threshold-crossing alerts from [Resource usage](#resource-usage--the-server-side-design)
are producers, and so are the audit-derived security alerts already specified above.

```ts
type NotifyEvent =
  | { kind: 'turn_complete'; projectId: number; outcome: TurnOutcome;
      durationMs: number; message: string | null; backgroundTasks: number }
  | { kind: 'resource_alert'; resource: 'memory' | 'disk' | 'cpu';
      used: number; limit: number | null; percent: number }
  | { kind: 'security_alert'; event: AuditEventName; throttleKey: string;
      suppressedSince: number }
  | { kind: 'test' };
```

Three consequences, and each is a thing the implementation has to be built around rather
than retrofitted:

1. **A transport decides its own formatting.** Telegram's 4096-character cap and its
   truncate-then-attach behaviour are properties of Telegram, not of "a notification". A
   later SMTP transport would render the same event as a subject and a body with no cap at
   all, and an ntfy transport as a title and a priority. A pre-rendered string forces every
   transport to accept Telegram's shape.
2. **Redaction stays at enqueue time**, which the M1.7 design already requires — so the
   *event's* string fields are redacted and base-path-elided before the row is written,
   and rendering afterwards only ever composes already-clean values. This is the one place
   the typed-event change has to be careful: it must not become an excuse to redact at
   send time, because the queue table persists on the volume.
3. **The `notification_queue` row stores the serialised event**, not `title` and `body`.
   The column list above changes accordingly: `kind` stays (it is the discriminant, and it
   is what a query filters on), `title`/`body` are replaced by a single `event_json`, and
   the rendered text is never persisted at all.

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
- **The hook endpoint's two credentials:** a correct bearer with a wrong shared secret, a
  wrong bearer with a correct shared secret, a bearer for a project that does not exist,
  and a bearer for a project that does. The first three must produce **byte-identical**
  responses — the test compares statuses *and* bodies rather than settling for all-4xx.
  Rotating either credential invalidates the old value. A static scan asserts no file
  outside the hook route names either header.
- **The chat allowlist runs before parsing:** a callback from an unlisted `chat_id` is
  dropped with the body never parsed, asserted by handing it a body that would throw in the
  parser and requiring the drop rather than the throw.
- **The link setting:** with `PANEL_NOTIFY_INCLUDE_LINKS` false — the default — no rendered
  message contains the base path in any spelling, swept the same three ways
  `plugins/logger-redaction.ts` sweeps. With it true the link is present and the stored
  `event_json` still is not.
- **Typed events:** `notify()` refuses a pre-rendered string at the type level and at
  runtime; each event kind renders to the documented shape; a `resource_alert` and a
  `security_alert` reach the same queue as a `turn_complete` without the transport knowing
  which produced them.

#### Files

`src/server/services/notify.service.ts` (queue and `notify()`),
`src/server/services/telegram.transport.ts`,
`src/server/services/notification-rules.ts`,
`src/server/services/notification-render.ts` (typed event → per-transport text),
`src/server/routes/notifications.ts`,
`src/server/migrations/009_notifications.sql`, `tests/unit/notify.test.ts`,
`tests/unit/telegram-transport.test.ts`,
`tests/unit/notification-render.test.ts`,
`tests/integration/notifications.test.ts`.

The hook endpoint's own files land with **Phase 3**, not here — `routes/internal-hooks.ts`
and the second listener — but the two credentials it needs are M1.7's, because they are
stored, rotated and audited by the same machinery as the Telegram pair.

## Resource usage — the server side (design)

**Design only. The widget is Phase 2 work; what is specified here is the endpoint and the
sampling behind it.** It is written down rather than built because the obvious
implementation is wrong in a way that produces a plausible-looking number, and a
plausible-looking wrong number in a resource display is worse than no display at all.

### The reason this needs specifying: `os.totalmem()` lies in a container

`os.totalmem()` and `os.freemem()` read the **host's** memory, not the container's limit.
On Railway that means a panel with a 1 GB service limit would cheerfully report the
figures of whatever machine the container landed on — tens of gigabytes, mostly free — and
the display would say "everything is fine" for the entire approach to an OOM kill. The
numbers are not approximate; they are about a different thing.

The values must come from **cgroup v2**, which is what the limit is actually enforced by.

| what | file | notes |
| :--- | :--- | :--- |
| memory used | `/sys/fs/cgroup/memory.current` | bytes, one integer |
| memory limit | `/sys/fs/cgroup/memory.max` | bytes **or the literal string `max`** |
| cpu used | `/sys/fs/cgroup/cpu.stat` → `usage_usec` | cumulative microseconds; useless from one sample |
| cpu allowance | `/sys/fs/cgroup/cpu.max` | `"<quota> <period>"`, or `"max <period>"` |
| memory pressure | `/sys/fs/cgroup/memory.events` → `oom_kill`, `high` | a count that only goes up; see below |

### `memory.max` can be the string `max`, and that case must render differently

An unlimited cgroup writes the literal `max`. Parsing that with `Number()` gives `NaN`,
and `used / NaN` is `NaN` — which formats as `NaN%` if you are lucky and as `0%` if some
helper coerces it. Neither is acceptable.

The contract: the limit is `number | null`, `null` meaning unlimited, and **a null limit
renders as a used-only figure** — `"412 MB used"` — with no percentage, no bar, and no
denominator. Not `412 MB / ∞`, not `412 MB / 0`, and not a bar at 0 %. A UI that cannot
show a proportion should show the number it does have and say nothing about the number it
does not.

### CPU needs two samples, and there is no way around it

`usage_usec` is cumulative CPU time since the cgroup was created. A single reading divided
by anything is meaningless — early in a container's life it looks idle no matter what it is
doing, and after a week of uptime it looks pinned. A percentage is a **rate**, so it needs
two samples and the wall-clock interval between them:

```
percent = (usage_usec₂ − usage_usec₁) / (elapsed_µs × cores) × 100
cores   = quota / period   from cpu.max,   or os.cpus().length when it is "max"
```

The `× cores` term is the part that is easy to omit and produces a number that is wrong by
a factor of the core allowance: a process fully using one core in a two-core allowance is
at 50 %, not 100 %. Sampling interval **1000 ms**, taken by the same background sampler
described below, so a request never waits for a second sample.

### Not containerised is a state, not an error

When `/sys/fs/cgroup/memory.current` is absent — a developer's machine, a non-cgroup-v2
host — fall back to `os.totalmem()`/`os.freemem()` and `os.cpus()`, and set an explicit
flag:

```ts
{ source: 'cgroup-v2' | 'os', containerized: boolean, ... }
```

The flag is in the payload, not inferred by the client, and the UI says so
("host figures — not containerised"). The alternative — silently substituting host numbers
— is exactly the failure this whole section exists to avoid, just relocated to the machine
where it is least likely to be noticed.

### Disk, because it is the one that fills up silently and takes the database with it

Memory pressure announces itself: the container is killed and restarted. A full volume does
not. SQLite starts returning `SQLITE_FULL` on write, the audit log stops accepting rows,
and a panel that cannot write its own audit log is a panel whose security model has quietly
stopped working. The volume is also the thing that grows without anyone deciding to grow
it: project checkouts, `node_modules` trees, agent scratch files, the WAL.

- Read with `statfs` on `PANEL_DATA_DIR`: total, free, and used-by-us.
- Report **both** the filesystem figure and the panel's own footprint (`panel.db` plus its
  sidecars, and the total under `projects/`), because "the volume is 80 % full" and "the
  database is 80 % of the volume" call for completely different actions.
- The alert threshold here is lower than for memory, and deliberately: see below.

### The endpoint

`GET /api/system/resources`

- **Full session required.** Not step-up: reading a resource figure is not a state change,
  and gating it behind a fresh code would push the operator toward not looking — the same
  reasoning as the audit query API in M1.5.
- **Exempt from the mutating-request machinery**, because it is a `GET`: no CSRF token, no
  `Origin` requirement. It is *not* exempt from `Host` validation or from the per-session
  rate-limit bucket, and it should not be — unlike `/healthz` it is inside the base path
  and behind a session, so neither exemption has a reason.
- **Served from a cache, never computed per request.** One background sampler on a
  `setInterval` of **1000 ms** maintains the current figures; the endpoint returns the last
  snapshot plus its `sampledAt`. A polling UI at 2 s and a second browser tab must not
  double the cost of anything, and a resource display that becomes its own load is a joke
  the operator will not find funny twice.
- The sampler is a single timer with a guarded body, like the M1.7 queue worker: it never
  throws out of itself, and a read failure degrades one field to `null` rather than taking
  the endpoint down.
- Response shape:

```ts
interface ResourceSnapshot {
  sampledAt: string;                 // ISO-8601
  source: 'cgroup-v2' | 'os';
  containerized: boolean;
  memory: { usedBytes: number; limitBytes: number | null; percent: number | null };
  cpu:    { percent: number | null; cores: number | null };   // null until two samples exist
  disk:   { path: string; totalBytes: number; freeBytes: number; usedBytes: number;
            percent: number; databaseBytes: number; projectsBytes: number };
  perProject?: ProjectUsage[];       // Phase 3 onward; see below
}
```

Nothing in it is a secret — `path` is `/data`, which is in the runbook — and in particular
**it must not carry the base path**, which is why `path` is the data directory and not a URL.

### Threshold-crossing alerts, which is what feeds M1.7

Alerts fire **on a crossing, not on a level**, or a full disk sends a message every
sampling interval forever. Each rule holds a state — `below` or `above` — and emits only on
a transition, with hysteresis so a value oscillating on the boundary does not chatter:

| resource | fires above | clears below | why this number |
| :--- | :--- | :--- | :--- |
| memory | 85 % | 75 % | an OOM kill takes the agent processes with it, and 85 % of a small limit is minutes of warning, not hours |
| disk | 80 % | 70 % | lower than memory on purpose: recovery means deleting things, which takes a human, and a full volume stops the audit log |
| cpu | 90 % sustained 60 s | 70 % | high CPU is usually a *legitimately* busy agent, so the sustain window is what stops it being noise |
| `oom_kill` count increased | any increase | — | not a threshold at all. This is the one that already happened, and it is the most valuable alert in the list: the panel can say "an agent was killed for memory" instead of leaving the operator to wonder why a turn never finished |

Each becomes a `{ kind: 'resource_alert', ... }` typed event through `notify()`, so it
reaches the operator by the same path as a security alert and a finished turn. They inherit
M1.7's per-rule throttling for free, which matters because the hysteresis above stops
*chatter* but not a genuinely bouncing workload.

### Per-project attribution, from Phase 3 — and it is an estimate

Once the panel runs agent processes, "the panel is at 90 % of memory" is much less useful
than "the `acme-web` agent is using 700 MB of it". The mechanism:

- each project's agent has a known root process — the pty's child, or the tmux session
  leader — recorded when the panel spawns it;
- walk `/proc/<pid>/task/*/children` (or `/proc/*/stat`'s ppid field) to enumerate the
  process tree from that root;
- sum **RSS** across the tree, from `/proc/<pid>/statm` or `smaps_rollup`.

**This is an estimate, and the UI must say so**, because summing RSS over a process tree
double-counts shared pages. A parent and three children sharing the same libc and the same
Node binary each report those pages in their own RSS, so the sum exceeds the memory
actually attributable to the group — sometimes considerably, for a tree of Node processes.
`PSS` from `smaps_rollup` divides shared pages by the number of sharers and is the better
answer, but it is more expensive to read and is not available for a process the panel does
not own.

So: sum RSS, label it "approximate", and make the **cgroup total the authority** for
anything that matters. The per-project figures are for answering "which project should I
look at", not for adding up to the total — and they will not add up to the total, which is
a thing to state in the UI rather than a bug to chase. If Phase 3 gives each project its
own cgroup (a plausible later refinement, since the panel spawns the processes), that
replaces this entirely with an exact number, and this section should be deleted rather than
adjusted.

### Files, when it is built

`src/server/services/resources.service.ts` (the sampler and the cgroup readers),
`src/server/services/resource-alerts.ts` (the crossing state machine),
`src/server/routes/system.ts`, `tests/unit/resources.test.ts` (with fixture cgroup files,
including `memory.max` = `max` and a two-sample CPU calculation),
`tests/unit/resource-alerts.test.ts` (crossings, hysteresis, and the `oom_kill` counter),
`tests/integration/system-resources.test.ts` (full session required, cached between
requests, no base path in the body).

## Concurrency — what the panel supports, and what it does not

**Design only, and the answer is deliberately asymmetric**: concurrency across projects is
the point of the product, concurrency inside one project is a hazard that gets a policy.

### Different projects: the central case, and it needs nothing special

Two agents in two projects are two process trees with nothing in common but the machine.
The isolation is already in the directory layout:

- separate working directories under `/data/projects/<id>/`;
- separate `CLAUDE_CONFIG_DIR`, so per-project settings, history and credentials do not
  mix;
- separate process trees, separate ptys, separate `.claude/settings.json` and therefore
  separate hook tokens (see the two credentials above).

Nothing else is required. There is no shared mutable state between two projects' agents,
so there is no lock to take and no queue to serialise on. The only limit is resources, and
that is the cap below rather than a concurrency mechanism.

### The same project: a correctness hazard, not a capacity one

Two agents in **one working directory** is a different problem, and it is worth being
precise about why, because "it might be slow" is not the issue:

- **Two agents editing the same files.** Both read a file, both decide what it should say,
  both write. The second write wins and the first agent's reasoning is silently discarded —
  and neither agent has any way to notice, because each sees a file that says what it just
  wrote. This is not a race that better locking fixes; it is two independent plans applied
  to one tree.
- **git refuses, visibly.** `.git/index.lock` exists precisely to stop two processes
  staging at once, so the *second* agent gets `fatal: Unable to create '…/.git/index.lock':
  File exists` — which it will then try to reason about, possibly by deleting the lock
  file. An agent that has been told to make the build pass and is being blocked by a lock
  file is one prompt away from `rm -f .git/index.lock`.
- **Branch state is a single global.** `git checkout` is not a per-process view. One agent
  switching branches moves the other agent's working tree underneath it, mid-task.

**The policy:**

1. **One agent per project working directory. Enforced, not advised.** The panel holds an
   in-process lock keyed on the project id, taken when an agent is spawned and released
   when its process tree exits. A second spawn request for a project that already has a
   live agent does not queue and does not fail silently — it is answered with a `409` and
   the choice below.
2. **A second concurrent agent in one project gets its own git worktree.** `git worktree
   add /data/projects/<id>/worktrees/<agent-id> -b agent/<agent-id>` gives it a separate
   working directory, a separate index, a separate `HEAD` and a separate branch, sharing
   only the object database — which is exactly the thing that *is* safe to share, since git
   objects are content-addressed and append-only. The three hazards above all disappear:
   different files, different index lock, different branch.
   - This is why `git` is in the Phase 3 install list in the `Dockerfile` and not the
     Phase 5 one: the worktree is not an optimisation, it is how the second agent is
     possible at all.
   - The panel creates the worktree, records it against the agent, and removes it
     (`git worktree remove`) when the agent finishes and its branch has been merged or
     abandoned. A stale worktree is a directory that looks like a project and is not one,
     so cleanup is part of the spawn contract rather than a maintenance task.
   - **Merging is the operator's job, not the panel's.** Two branches from two agents are a
     decision, and the panel's role ends at making them exist separately.
3. **A project with no git repository gets no second agent.** There is nothing to make a
   worktree from, so the `409` is the whole answer. This is a real case — a project can be
   a directory of scripts — and the honest response is to say "one at a time here" rather
   than to invent isolation that is not there.

### The binding limits are memory and the upstream API, not CPU

Worth stating because it inverts the intuition that a cap should be about CPU:

- **An agent waiting on a model response is idle.** It has an open HTTPS connection and no
  work to do, and that is most of its wall-clock life. Ten agents mid-turn are not ten
  busy cores; they are ten sleeping processes and one that is applying an edit. CPU spikes
  when a tool runs — a build, a test suite, a `grep` over a large tree — and those are
  bursty and short next to the model latency they are interleaved with. A CPU-derived cap
  would allow far too many agents and then be the wrong constraint anyway.
- **Memory does not go away between turns.** Each agent is a Node process with a
  conversation in it, plus a pty, plus whatever the tools it ran left resident. That is a
  floor per agent that persists for the whole session, and on a 1 GB service it is the
  number that decides how many can exist. Exceeding it is not degradation, it is an OOM
  kill that takes the whole container — every agent, not just the newest.
- **The upstream API has its own concurrency limit**, and hitting it produces `429`s that
  the agents will interpret as failures of the task rather than of the panel. The panel's
  cap should sit *below* whatever the account's limit is, so that the panel is the thing
  that says "not now" rather than the API.

### The global cap

`PANEL_MAX_CONCURRENT_AGENTS`, configurable, **default derived rather than hardcoded**:

```
default = clamp(1, floor((memoryLimitBytes × 0.7) / PER_AGENT_MEMORY_ESTIMATE), 8)
```

reading `memoryLimitBytes` from the cgroup figure in
[Resource usage](#resource-usage--the-server-side-design) — which is the reason that
section has to be built first, and the reason it has to read the *cgroup* and not
`os.totalmem()`. A default computed from the host's memory would allow a dozen agents on a
1 GB service and OOM the container on the third.

- `PER_AGENT_MEMORY_ESTIMATE` starts at **250 MB** and is a constant to be corrected by
  measurement once Phase 3 exists, not a guess to be defended. It is named as an estimate in
  the code.
- The `× 0.7` leaves the panel itself, SQLite's page cache and a tool invocation's own
  memory out of the agent budget.
- The upper clamp of 8 is not about memory; it is the API-concurrency reasoning above. A
  panel that could run 40 agents on a large instance still should not.
- **When the limit is unlimited (`memory.max` = `max`), the default is 2, not unbounded.**
  An unknown limit is not permission.

**What the UI does when the cap is reached** — and "shows an error" is not a specification:

- The spawn control is **disabled with the reason on it**: "3 of 3 agents running — stop one
  to start another", not a greyed-out button with a tooltip nobody hovers.
- The list of running agents is right there, each with its project, its elapsed time and its
  memory figure from the per-project attribution above, so the operator can see *which* one
  to stop. A cap that does not show what is using it makes the operator guess.
- **No queue.** A request to start an agent that is queued behind another for an unknown
  number of minutes is worse than a refusal: the operator walks away believing work has
  started. If queueing is ever wanted, it is a visible queue with positions and an estimated
  start, which is a feature and not a fallback.
- The server refuses independently of the UI — `409` with the current count — because the
  API is reachable without the client and the cap is a resource guarantee, not a form
  validation.

### The panel runs a shell in a pty, so it is not Claude-specific

This is recorded because it is much cheaper to keep true than to make true later.

**What is generic:** the pty, the terminal WebSocket, the tmux session that survives a
dropped socket, the process-tree accounting, the concurrency lock, the worktree mechanism,
the project directory layout, and the resource caps. All of that is "run a long-lived
interactive process in a directory and let the operator watch it". None of it mentions
Claude Code.

**What assumes Claude Code, and is exactly two things:**

1. **The `settings.json` editor.** It edits `.claude/settings.json` against Claude Code's
   schema — hooks, permissions, `allowedEnvVars`. A different agent has a different
   configuration file, or none.
2. **The Stop-hook integration.** `POST /internal/hooks/stop`, the payload fields
   (`stop_hook_active`, `last_assistant_message`, `cwd`, `background_tasks`), and the
   `.claude/settings.json` the panel writes to install the hook. This is the *only* reason
   the panel knows a turn finished.

So "run a different CLI agent in this project" is: a second implementation of a
`TurnSignal` seam (whatever tells the panel a turn ended — an HTTP hook, a sentinel line, a
process exit) and a second configuration editor. It is **not** a rewrite, provided those two
stay behind their seams and nothing else grows a dependency on Claude Code's file layout.
The concrete rule to hold to: **no module outside `settings-editor.ts` and
`internal-hooks.ts` may name `.claude`, `settings.json`, or a Claude Code payload field.**
That is enforceable by the same kind of static scan as the client-IP and cookie rules, and
it should be added when those two files are.

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
because it is the reason M1.7 exists, and because two of its decisions constrain
M1.7's shape: the transport must accept an enqueue from a route that has no session,
and the queue must be the thing that answers, not the network.

Depends on M1.7 for delivery.

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
requirement that makes M1.7's persisted queue mandatory rather than merely tidy: the
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

- [x] Docker build verified, container boots as uid 10001 with an empty volume
      (M1.6 part 2.4: `docker build`, a fresh named volume, migrations applying from
      nothing, the user seeded, the base path generated, `/healthz` answering from
      outside, a full two-stage login through `curl`, then a restart on the same
      volume with nothing re-seeded.)

### The eleven acceptance criteria

**These were reconstructed in M1.6, and that needs saying plainly.** The original
project prompt referred to "11 acceptance criteria" in its security section. *That
prompt is not in this repository and never was* — the note that used to sit here said
so, `git log -S acceptance` finds no other copy, and nothing under the repository root
contains them. Rather than leave the gap open for a third milestone, the eleven below
are derived from the **Security Model** section of `CLAUDE.md`, which is the surviving
statement of the same requirements and which enumerates exactly eleven items: the
single-user rule plus the ten defence-in-depth bullets. The correspondence is
one-to-one and in order, which is the reason to believe it is the right list.

If the operator's original list differs, **this is the thing to correct** — and now
that they are executable, correcting them means editing `scripts/acceptance.sh`.

They are run against a **running container**, not the dev server:

```
npm run acceptance -- <dev-container> <dev-port> <prod-container> <prod-port> <prod-domain>
```

| | Criterion | How it is exercised end to end |
| :--- | :--- | :--- |
| C1 | Exactly one user, seeded from the environment on first boot, never re-seeded | one `users` row; the stored hash fingerprinted before and after a restart; the second boot's warning that `PANEL_ADMIN_PASSWORD` is ignored |
| C2 | The secret base path gates everything, `/healthz` excepted, and never reaches a log | `/healthz` outside the prefix; a wrong prefix and the bare root are the same generic 404; the API only under the prefix; `Referrer-Policy: no-referrer`; the prefix in **no** structured log line, elided as `<base>`, with the first-boot banner the one documented carrier |
| C3 | argon2id password hashing plus mandatory TOTP; a password alone is never enough | the stored hash is `$argon2id$`; stage one yields `{"stage":"totp"}` and a `pre` session that cannot reach a full-session route; the TOTP secret is stored as a `v1.` ciphertext, not base32; stage two promotes it |
| C4 | A progressive response delay, not a lockout, and no per-IP logic anywhere | six failures timed, each from a **different** `X-Forwarded-For`: unpadded, unpadded, unpadded, ~500 ms, ~1 s, ~2 s — then the correct password still succeeds; `auth_failures` has no address or scope column; `lockouts` stays dropped |
| C5 | Opaque server-side sessions, stored only as a hash, revocable on the next request | 64-hex `token_hash`; the plaintext token absent from `panel.db`, `-wal` **and** `-shm`; `DELETE /api/sessions/:id` then a 401 on the very next request with that cookie |
| C6 | `SameSite=Strict`, strict `Origin`/`Host` validation, and a session-bound CSRF token | both cookies `SameSite=Strict`, `HttpOnly` on the session one, both scoped to the prefix; foreign `Origin` → 403; missing and wrong CSRF token → 403; the same request with the real pair → 200; on the production container a poisoned `Host` → 403 while `/healthz` stays exempt, and a forwarded plaintext hop → 403 |
| C7 | The response header set, and HSTS in production only | the seven security headers byte-for-byte on the dev container with **no** HSTS; the full HSTS value on the production one; `Server`, `X-Powered-By` and `X-XSS-Protection` absent |
| C8 | Secrets at rest: AES-256-GCM under an HKDF subkey, versioned, never in plaintext | a sentinel written through `PUT /api/secrets` behind a step-up; the stored payload is the `v1.` envelope; the plaintext in none of the three SQLite files and no log line; revealed back through the API; the audit rows carry the reference, not the value |
| C9 | The audit log is append-only through two independent controls | `GET /api/audit/verify` → `ok:true`; `UPDATE` and `DELETE` both refused by migration 008's triggers; then the triggers **dropped** and a row edited — the keyed chain reports `row_hash_mismatch` at that row, with `hint: null` because the break is not at the oldest row |
| C10 | Rate limiting with no address in it, plus size and receipt-time bounds | a 1 MiB body → 413; 70 unauthenticated requests with a rotating `X-Forwarded-For` → 429 with `Retry-After ≥ 1`; `/healthz` and the out-of-prefix 404 sink stay exempt |
| C11 | Boot-time self-checks refuse to start on a critical misconfiguration | six `docker run` invocations that must all exit non-zero — no master key, a key under 32 bytes, production with no public origin, production with an http one, a weak admin password, no user and no credentials — plus the entrypoint bypassed, where the server refuses to serve as root |

**Result on 2026-09-03: 79 checks across the eleven, 0 failures**, against
`cc-panel:local` built from this tree, one container on the development profile and one
on the production profile. C9 runs last because proving the chain detects tampering
means tampering with that container's log.
