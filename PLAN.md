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
design section below, and M1.8's under §*Built in M1.8*
(`services/watchdog.service.ts`, `services/resource-alerts.ts`,
`migrations/010_watchdog.sql`, `tests/unit/resource-alerts.test.ts`,
`tests/unit/watchdog.test.ts`, `tests/integration/watchdog.test.ts`).

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

## Phase 2–5 requirements (R1–R8)

**R1–R7 recorded 2026-09-03, R8 on 2026-09-05, from the operator, after M1.6.
Authoritative for Phases 2–5.** Stated in the operator's own terms first, before anything is
designed against them, and tagged R1–R8 so that any later line of code can be traced back to
the requirement that caused it. Designs answering them carry the tag.

| | The requirement, as stated | Designed in |
| :--- | :--- | :--- |
| **R1** | Manual, complete backup of the panel, taken by the operator on demand. | [`docs/PORTABILITY.md`](docs/PORTABILITY.md) → M2.6 |
| **R2** | Uploading that same backup into a *different* panel reproduces the first panel completely: all panel settings, and all projects usable in the new panel. *"all information of that panel transfers to the other panel completely."* | [`docs/PORTABILITY.md`](docs/PORTABILITY.md) → M2.6 |
| **R3** | The panel is bilingual (Persian and English). | M2.1 below |
| **R4** | For each project: browse its files, download any file, edit any file in the panel, and upload new files. | [`docs/FILES.md`](docs/FILES.md) → M2.3 |
| **R5** | Per-project Claude Code `settings.json`, set separately, dedicatedly, and by hand. | M2.4 below |
| **R6** | Telegram token and the rest of the Telegram settings configurable from the UI, with a "test the bot" action. | M1.7 §*Interface* → M2.5 |
| **R7** | `api_key` and `api_base_url` configurable per project from the UI, in addition to `settings.json`. Plus a global section for `api_key`, `api_base_url` and a hand-edited `settings.json`, whose values are the default for every project that has not been given its own. | M2.4 below |
| **R8** | Upload an unfinished project — built with Claude Code or with any other tool — and have the panel take it over. *"If the project was built with Claude Code, the panel should detect that and use that project's Claude Code configuration as the panel's configuration for it."* Both arrival paths are wanted: a ZIP upload **and** a clone from a git URL. An uploaded project's git history is kept, with hook execution neutralised. | [`docs/IMPORT.md`](docs/IMPORT.md) → M2.8 |

### Earlier requirements stand unchanged

The Telegram notification on completion naming the project (M1.7 and
[Phase 3 preview](#phase-3-preview--claude-code-finished-notifications)), the RAM/CPU
usage widget ([Resource usage](#resource-usage--the-server-side-design)) and the
[concurrency policy](#concurrency--what-the-panel-supports-and-what-it-does-not) are as
written. Where the new requirements touch them, the note below says how — there is no
second, competing design for anything already specified.

### Where R1–R7 overlap what is already designed

- **R6 × M1.7.** M1.7 keeps everything: the two encrypted values, the queue, the
  worker, the 4096-character split, the typed event, the message format, the two hook
  credentials. R6 adds **only** a configuration surface over the storage M1.7 already
  specifies, plus two actions that are new (a real test send, and chat-id discovery).
  The M1.7 section below is extended in place and marked *transport* / *interface*.
- **R7 × M1.7's `v2` payload AAD.** M1.7 already changes `SecretsRepository` to bind a
  ciphertext to `(scope, name)` rather than to the row id. R7 needs exactly that change
  and no other, with one amendment: the project scope is `project:<uuid>`, not
  `project:<rowId>` — see [R2 and portable identity](#m22--projects-identity-layout-and-crud).
  One change, one migration, whichever milestone lands first.
- **R2 × `npm run backup` / `npm run restore` (M1.6).** Two different mechanisms that
  must not be confused. The M1.6 pair is a **single-instance snapshot**: SQLite's online
  backup API over `panel.db`, restored onto the same panel, carrying ciphertext that only
  this panel's `PANEL_MASTER_KEY` can read — it *refuses* a snapshot whose chain fails at
  its oldest row precisely because that is what another panel's key looks like. R1/R2 add
  a **portable export**: a decrypt-on-the-way-out, re-encrypt-on-the-way-in logical
  document with no panel ciphertext in it, no account, no audit log, and no base path.
  Keep both. The snapshot is for "this panel broke"; the export is for "move to another
  panel". Neither can do the other's job, and `docs/PORTABILITY.md` §1 says why.
- **R4 × the concurrency policy.** An operator editing a file in the panel while an agent
  edits the same file is the first two hazards of
  [the same project](#the-same-project-a-correctness-hazard-not-a-capacity-one) minus the
  git index lock. It does **not** get the one-agent lock: the operator is not an agent, and
  a panel that refuses to open a file because an agent is running is a panel that cannot be
  used for the thing it exists for. It gets optimistic concurrency instead —
  `docs/FILES.md` §4.
- **R5/R7 × "the panel is not Claude-specific".** The
  [two things that assume Claude Code](#the-panel-runs-a-shell-in-a-pty-so-it-is-not-claude-specific)
  are unchanged in number. R5 and R7 make the first one — the settings editor — much
  larger, and the standing rule extends to it verbatim: **no module outside the settings
  generator and `internal-hooks.ts` may name `.claude`, `settings.json`, or a Claude Code
  payload field**, still enforceable by the same static scan.
- **R8 × decision 3, and it is the one overlap that *removes* an advantage.**
  [`docs/PORTABILITY.md`](docs/PORTABILITY.md) §5.5's argument for a bespoke export container
  was that it cannot express a symlink, a hardlink, a device node, a fifo, a setuid bit or an
  absolute path — so six rejections became structurally impossible rather than merely
  implemented. A ZIP or tarball of somebody else's project can express all of them, so **R8
  gives that surface back**, and §7.1's entry-type row stops being a placeholder for a future
  move to `tar`. [`docs/IMPORT.md`](docs/IMPORT.md) §3 recovers most of the advantage a
  different way (ZIP only, external attributes never read, every entry written as a regular
  file with a fixed mode) and names what is left over. The containment function
  ([`docs/FILES.md`](docs/FILES.md) §2) is reused and **a second one is not acceptable**.
- **R8 × R5/R7's settings model.** M2.4 was designed around sources the panel owns. R8
  introduces one it does not — a workspace file that *outranks* the panel's own — and
  [`docs/IMPORT.md`](docs/IMPORT.md) §11 lists the four changes M2.4 must make for it,
  including a correction: M2.4's claim that *"the operator cannot break the turn-complete
  notification by hand"* is false, because `hooks.Stop` in a workspace `.claude/settings.json`
  outranks the user-level file the panel generates.
- **R8 × M2.2's table.** The provenance and review columns must be in migration `012` from the
  start ([`docs/IMPORT.md`](docs/IMPORT.md) §10). A column added later is an `ALTER` against
  live operator data; the per-item approval **table** is not, and lands with R8.
- **R3 × everything server-side.** The server gains no locale. `GET /api/audit`,
  `GET /api/system/resources` and every error body stay machine-readable; the client owns
  every human string. The one exception is M1.7, which has no client — see M2.1 §*The
  server does not translate*.

### Decisions taken after M2.0 (2026-09-04)

The M2.0 design left open questions; these are the answers, recorded here rather than in
the milestone prose so that the set can be checked off. Each is tagged with the milestone
that builds it. **Only the M1.7-tagged ones are built** as of `feat(m1.7): telegram
notifications`; the rest are decided and waiting. The M1.8 decisions continue the numbering
in their own dated subsection below.

1. **Export defaults to including workspace files (M2.4).** A project without its files is
   not the project, and an operator who wanted the metadata alone can uncheck it. The dry
   run prints, per project, the branch and the remote it found, so "this one has a remote,
   its `.git` is excluded, and here is where to clone it from" is visible before the export
   runs rather than inferred from a size that came out smaller than expected
   ([`docs/PORTABILITY.md` §6](docs/PORTABILITY.md#6-workspace-files)).
2. **A UUID that already exists on import offers skip / overwrite / copy (M2.4)**, and
   *copy* is the one with obligations. A workspace moved aside gets a defined home
   (`/data/projects/<uuid>.superseded-<timestamp>`), a name that sorts and cannot collide,
   a line in the import result naming it, its size shown in the projects list, and a delete
   action. **Nothing auto-deletes it**, ever, on any schedule: the panel is not allowed to
   be the thing that removed the only copy of a workspace the operator was mid-decision
   about. The cost — a volume filling with superseded workspaces — is visible in the
   resource widget, which is where a disk problem belongs.
3. **The bespoke container stands (M2.4)**, on the condition that a `v1` file stays
   readable without the code that wrote it. That condition is now met:
   [`docs/PORTABILITY.md` §5.7](docs/PORTABILITY.md#57-the-v1-byte-layout-exactly) is a
   byte-offset table for the file, the frame, the per-frame AAD, the wrapped key and the
   reader's refuse-before-allocating rules, including the endianness that §5's diagram left
   unstated. It was **added in M1.7**, since the condition was attached to a decision and
   an unwritten table is not a met condition.
4. **Import caps are checked during the write, not only before it (M2.4).** A free-space
   check that runs once, before a four-gigabyte extraction, answers a question about a disk
   that no longer exists by the time the answer matters. Re-check periodically as bytes
   land and abort naming the shortfall — how many bytes short, not "insufficient space".
   `PANEL_IMPORT_MAX_BYTES` (2 GiB) and `PANEL_IMPORT_MAX_UNCOMPRESSED_BYTES` (4 GiB) stay
   as configurable defaults. **`/data/exports/incoming/` is swept at boot**, because an
   import killed mid-upload leaves a partial file that nothing will ever claim, and a
   directory that only grows is a disk that fills for a reason nobody remembers.
   `ensureDataLayout()` and `entrypoint.sh` already create both directories as of M1.7.
5. **Passphrase floor 16, generated default 20 (M2.4)**, and the no-recovery sentence is
   the one already written for `PANEL_MASTER_KEY` in `docs/SECURITY.md` §*Key rotation*:
   the panel does not store it, cannot reset it, and cannot help. The wording is in
   [`docs/PORTABILITY.md` §5.6](docs/PORTABILITY.md#56-the-passphrase) and the UI must use
   it verbatim or better. **KDF parameters are bounded in both directions** —
   [§7.5](docs/PORTABILITY.md#75-the-kdf-parameters-are-attacker-controlled-too) already
   caps `m ≤ 262144` KiB, `t ≤ 10`, `p ≤ 4` and floors `m ≥ 65536`, `t ≥ 3`. Upward is a
   memory-exhaustion kill delivered by a file; downward is a file asking to be cheap to
   attack offline.
6. **Provider credentials default to `Bearer` / `ANTHROPIC_AUTH_TOKEN` (M2.6),** and the
   hint text **must not name a provider**: this operator's base URL is not Anthropic's, the
   set of gateways changes faster than this panel will, and a hardcoded name is wrong for
   every deployment but one. Two facts belong with that default because they are
   observable behaviour and not preference:
   - `ANTHROPIC_API_KEY` triggers Claude Code's **one-time interactive approval prompt** on
     first use. So the first spawn in a project configured that way must have a visible
     terminal, or the agent hangs on a question nobody can see. `ANTHROPIC_AUTH_TOKEN` does
     not prompt, which is the practical reason it is the default and not merely the
     stylistic one.
   - A non-first-party `ANTHROPIC_BASE_URL` **disables MCP tool search and Remote
     Control**. Not a warning, a capability change, and the settings UI should say so where
     the base URL is entered rather than leaving the operator to discover that a feature
     stopped existing.
7. **M1.7's transport lands before the Telegram UI and before the client (M1.7).** Done:
   two commits, no UI, everything reachable from the existing JSON API and three CLI
   commands. The M2.5 configuration surface has an endpoint to call and needs no new one —
   see §*Built in M1.7*, decision 6.

Three of those arrived as corrections to what was already written down, and are recorded
where they contradict it:

8. **`mask()` is the wrong display for the Telegram values (M1.7).** Last-four of a
   nine-digit chat id leaves almost nothing. Report set/unset plus a character count, the
   way `npm run preflight` does. The M1.7 configuration section below said `mask()`; it is
   corrected in place.
9. **The hook token and the panel-wide shared secret do not transfer (M2.4)** — already a
   row in [`docs/PORTABILITY.md` §2](docs/PORTABILITY.md#2-what-transfers-and-what-does-not),
   confirmed rather than added. Import generates fresh ones, which is why it must also
   regenerate each project's generated settings.
10. **Conversation transcripts are an opt-in checkbox, off by default (M2.4).** The earlier
    table excluded them from `v1` outright. An operator moving machines may legitimately
    want their own history; what is not acceptable is it travelling by default or without
    them having read what is in it. That row is rewritten.

And two that are settled rather than open:

11. **CodeMirror 6 for the `settings.json` editor, no web worker (M2.4).** Decided, not an
    option to weigh later. The CSP has no `worker-src` and therefore falls back to
    `default-src 'none'`, so a worker-based editor does not load — and the fix is not to
    add `worker-src`: a worker is a second script context, and the reason to want one is
    heavy language tooling this editor does not have. CodeMirror 6 runs on the main thread,
    needs no `unsafe-eval`, and a `settings.json` document is a few kilobytes. **Do not add
    `worker-src` to the CSP to make an editor work.**
12. **Migration numbering: M1.7 took `009`.** It landed first. M2.2's projects table takes
    the next number, and the rule is the obvious one — a migration number is claimed by the
    commit that lands, never reserved by a plan. *M1.8 then took `010`* by the same rule, and
    *M2.1 took `011`* — `users.locale` plus the two `*_clearing_since` columns, one migration
    for one milestone — so **M2.2's projects table is `012`**, and R8's provenance and review
    columns ride in `012` with it. Every place that said `011` was the projects table has been
    corrected ([`docs/IMPORT.md` §10](docs/IMPORT.md) and §*The decisions that block M2.1*
    item 6 below); the number in a design is a claim about ordering and nothing else.

### Decisions taken in M2.1 (2026-09-05)

Numbered on from the M1.8 list below, which they continue rather than replace.

19. **The recovery debounce replaces the alert cooldown (M2.1).** The whole argument is in
    §*Built in M1.8*, item 3, where the paragraph it corrects lives. The one line worth having
    here: an alert channel whose last word can be false forever is worse than one that
    occasionally repeats itself.
20. **No absolute memory floor to go with the percentage (M2.1, and revisit at M3).** A second
    knob whose default has no evidence behind it is a setting nobody can tune. The figures
    that would justify one — how much memory a real concurrent-agent workload actually uses,
    and therefore what floor is worth alerting on — are produced by the resource widget built
    in M2.1. **Revisit at M3 with those numbers**, not before.
21. **`Watchdog.status()` is folded into `GET /api/metrics`, not given a route (M2.1).** A
    separate endpoint would have been a second response shape, a second poll to budget, and a
    second line in `EXPECTED_ROUTE_TREE`, for a payload the widget reads on exactly the same
    schedule as the figures it sits beside.
22. **`claude --settings` layers; it does not replace (M2.4, documentation only).** Verified
    against the current settings documentation on 2026-09-05 and recorded in §M2.4 and
    [`docs/IMPORT.md` §11.4](docs/IMPORT.md). The consequence that matters is not the
    reassuring half — it is that `hooks`, `mcpServers` and `permissions.allow` **merge**, so an
    uploaded workspace file's hook is *concatenated* with the panel's rather than outranked by
    it. That is why R8's executable class exists, and it is why merge semantics may be relied
    on for convenience and never for a security property.
23. **The client is plain CSS, not Tailwind (M2.1).** §M2.1 item 1 below says "Tailwind v4
    theme" and the code does not have one. The deciding argument is the enforcement: R3's
    logical-property rule is only real if a static scan can see a violation, and a scan over
    CSS declarations is exact where a scan over `className` strings has to encode Tailwind's
    whole utility vocabulary and fails *silently* when it misses one. Tailwind would also have
    put a native binary (`@tailwindcss/oxide`) in the builder stage for a design system of
    about 400 lines. Design tokens are custom properties in `globals.css`; the item is
    corrected in place.

### Decisions taken in M1.8 (2026-09-05)

Numbered on from the list above so the whole set stays checkable. 13–15 are built here;
16–18 are recorded and deliberately not built.

13. **The threshold alerts get M1.8 rather than waiting for M2.7 (M1.8).** The argument that
    decided it: the panel could already tell the operator about a failed login and not about
    the thing that actually stops it. Built with one addition the design did not have —
    unclean-restart detection, which is the only way an OOM kill that takes the whole
    container becomes visible at all. See §*Built in M1.8*.
14. **`MAX_ATTEMPTS` 12 → 15 (M1.8).** 77 minutes of trying instead of 32, at the same
    15-minute ceiling — and **the two figures the prose carried were both wrong**. The
    constant's comment said "~2 hours" and §*The queue* above said "a little over two
    hours"; twelve attempts is 1 023 s of doubling plus one wait at the ceiling, which is
    thirty-two minutes. Nobody had multiplied it out. So the window is now
    `totalRetryWindowMs()`, derived from the same three constants the scheduler uses, and
    `tests/unit/notify.test.ts` pins the derived figure against the schedule the worker
    actually produces *and* against the number quoted in prose. The reason for the increase
    stands on the corrected figure: half an hour is inside the length of an outage the
    operator has no part in — a Telegram incident, a transit problem, a token rotated and
    pasted back — and dead-lettering a security alert because a third party was down over
    lunch is the one failure this queue exists to prevent. Four more attempts at the ceiling
    cost one request per quarter hour.
15. **`PANEL_OUTBOUND_PROXY` stays unset in production, and `preflight` now says so
    (M1.8).** Telegram puts the bot token in the request **path**, so every hop between the
    panel and Telegram sees every token the panel will ever send. The boot warning only fired
    for a *non-loopback* hop; preflight now warns whenever the variable is set at all in
    production, because a loopback proxy is still another process in the same container
    reading the same URLs, and the boot log is not where an operator looks before deploying.
16. **`PANEL_NOTIFY_LOCALE` and `PANEL_NOTIFY_INCLUDE_LINKS` become runtime settings in
    M2.5, with the environment variable as the initial default (M2.5).** A settings screen
    that displays two values it cannot change is worse than one that does not show them.
    Both are read once at construction today (`app.ts` passes `locale` and `linkFor` into
    `NotifyService`), so M2.5's work is to make them a stored setting the constructor falls
    back to the variable for — not a new mechanism.
17. **The dead-channel banner in M2.5 is based on the age of the last successful send
    (M2.5).** Not on queue depth and the last failure alone. Three states have to look
    different: a channel that has never worked, a channel that stopped working, and a queue
    that is empty because nothing was enqueued — and only the age of the last success
    separates the third from healthy. `NotifyService.lastSuccessAt()` and `lastFailure()`
    already exist for it; the banner is the interpretation.
18. **`PANEL_NOTIFY_LOCALE=fa` on Railway (M1.8, configuration only).** The operator reads
    Telegram in Persian. The better secondary reason is that it gets the `fa` dictionary
    exercised against a real client's bidirectional rendering **before** M2.1 is built on top
    of it — the panel's own bidi rules are designed and unproven, and a chat window is the
    cheapest place to find out that a Latin-digit island reads wrong in a right-to-left line.
    This is an environment variable on the deployment, not a code change.

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
that reads the configuration back, which returns a `configured: boolean` and, per
value, **set/unset plus a character count**, never the values.

> **Corrected (decision 8 above).** This paragraph said `mask()`. It is wrong for these
> two: `mask()` reveals the last four characters, which is harmless on a 46-character bot
> token and is not harmless on a nine-digit chat id, where four digits is a meaningful
> fraction of a stable identifier for the operator's Telegram account. Set/unset plus a
> length is what `npm run preflight` already reports for every credential — it catches a
> truncated paste and a variable that never arrived, and discloses nothing that
> accumulates.

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

> **Superseded by what was built.** There is no `POST /api/notifications/telegram`. The
> credentials are written through the existing `PUT /api/secrets` with scope `telegram`,
> which is already step-up gated, already audited as `secret.changed`, and already swept
> by the sentinel test — see §*Built in M1.7*, decision 6. The paragraph below is kept
> because everything it says about *what the write must satisfy* still holds; only the
> route is gone.

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
   enqueued together does not retry in lockstep. After **15** attempts — 77 minutes of
   trying, a little over an hour and a quarter — the row goes to `abandoned` and stays in
   the table. Abandoned is not deleted: "the panel tried to tell you and could not" is
   itself information, and the queue is the only place it exists.

   *This paragraph said "After 12 attempts — a little over two hours" and was wrong twice
   over: twelve attempts is 1 023 s of doubling plus one wait at the 15-minute ceiling,
   which is thirty-two minutes and not two hours. M1.8 raised the cap to 15 (**decision
   14**) and replaced both figures with `totalRetryWindowMs()` in
   `services/notify.service.ts`, which derives the window from the same three constants the
   scheduler uses. `tests/unit/notify.test.ts` asserts the derived figure against the
   schedule the worker actually produces and against the number quoted here, so the three
   cannot drift again.*
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

#### The configuration interface (R6) — Phase 2, not transport

**Everything above this line is transport and is M1.7: the two encrypted values, the queue,
the worker, the 4096-character split, the typed event, the notification rules, the message
format, and the hook endpoint's two credentials. Everything below is interface and is M2.5,
which cannot ship before M1.7 exists.** The transport design is extended here, not rewritten.

**What the UI sets and rotates** — four values, each independently, each step-up gated
because each is a stored credential: the **bot token**, the **chat id**, the **per-project
hook bearer**, and the **panel-wide hook shared secret**. Rotating the shared secret
invalidates every project's hook at once and so has to regenerate every project's
`settings.json`; it is a confirmed action with that consequence spelled out, not a button.

**Nothing is displayed after saving: set-or-unset and a length**, the way
`npm run preflight` already reports a credential. That is a deliberate change to the M1.7
sketch, which returned `mask()`ed forms: `mask()` reveals the last four characters, which is
harmless for a 46-character bot token and is *not* harmless for a nine-digit chat id, where
four digits is a meaningful fraction of a stable identifier for the operator's Telegram
account. The rule the audit log already follows — never store or show `mask(value)` where it
accumulates — applies here for the same reason.

**The test action sends a real message and reports the real outcome**, mapped from
`error_code` plus a prefix match on `description`, and **never forwarding Telegram's own
text**, which echoes request parameters:

| What Telegram says | What the panel says |
| :--- | :--- |
| `401 Unauthorized` | *"Telegram does not recognise this bot token. Copy it again from @BotFather — a token stops working the moment you press /revoke."* |
| `400 Bad Request: chat not found` | *"Telegram has no chat with this id for this bot. Use "Find my chat" below rather than typing an id."* |
| `403 Forbidden: bot was blocked by the user` / `bot can't initiate conversation with a user` | *"Open Telegram, find your bot, and press Start. A bot cannot message someone who has not messaged it first."* |
| anything else | *"Telegram refused with code N. The panel does not show its message because Telegram's errors can echo what was sent."* — the category goes to the audit log. |

**The beginner trap this is designed around:** a bot cannot message a person who has never
messaged it, and a chat id is not something an operator knows or can look up. So there is a
discovery helper — *"message your bot, then press Find my chat"* — which calls `getUpdates`
and offers the candidate chats (`chat.id`, type, title or username) to pick from. This one
screen displays chat ids, and that is the exception that proves the rule: they are candidates
Telegram just handed us, not the stored value read back.

Two things it must handle rather than discover: `getUpdates` returns only recent updates, so
"press Start, then refresh" is the instruction; and `getUpdates` answers
`409 Conflict: can't use getUpdates method while webhook is active` if a webhook is ever set,
which gets its own message rather than being reported as "no chats found".

And the ordering already required stands: **the `chat_id` allowlist is checked before any
inbound message is parsed** — secret token, then allowlist, then parse. Discovery does not
change that, because discovery is an outbound poll the operator initiated, not an inbound
callback.

**The message format is unchanged** from *[The completion message](#the-completion-message-what-it-says-in-what-order)*:
project name first, then outcome, duration, the truncated last assistant message, then — only
under `PANEL_NOTIFY_INCLUDE_LINKS` — a deep link. The project name is not a secret; the base
path in the link is, and a Telegram message is permanent storage the panel does not control,
which is what gates the link rather than a preference about tidiness. The UI's description of
that setting says so in those words.

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

#### Built in M1.7 — and the six places it departs from the design above

The transport exists as of `feat(m1.7): telegram notifications`, plus
`utils/outbound-http.ts`, `services/telegram-config.ts` and three CLI commands the design
did not name. Everything above this line is the reasoning and still stands; these six
things are different in the code, each deliberately.

1. **The queue has four states, not five.** The design lists `pending`, `sending`, `sent`,
   `failed`, `abandoned`. `failed` is gone: with retries it is indistinguishable from a
   `pending` row carrying a `last_error` and a `next_attempt_at`, and two names for one
   condition is how a worker ends up with a row nothing ever picks up. A dead row is
   `abandoned`.
2. **`not_configured` does not consume an attempt.** The design's attempt counter would
   dead-letter every queued alert on a panel whose credentials are not set yet — which is
   every panel, between first boot and the operator's first visit to the settings screen,
   and *those* are the alerts most worth keeping (`setup.completed`, the first
   `login.success`). A send that fails because there is no token retries on a fixed
   interval with `attempts` left where it was, so the queue is waiting when the credentials
   arrive rather than full of corpses.
3. **The queue-full policy refuses the newest event and audits once per fill.** The design
   said "cap the queue" without saying which end. Refusing the newest is the right way
   round: the first alert of an attack is the most valuable and the thousandth is the most
   expendable, so evicting the oldest would discard exactly the row worth keeping.
   `notification_state` holds the drop count and the timestamp of the first drop since it
   was last reported, because a silent cap is a cap nobody knows was reached.
4. **The AAD upgrade is a boot-time code path, not part of migration 009.** The design says
   the migration re-encrypts any `v1` row. A SQL migration cannot re-encrypt anything, and
   a JavaScript migration step that threw — wrong master key, tampered row — would make the
   panel unbootable rather than merely leaving a legacy row in place. So
   `SecretsRepository.upgradeLegacyPayloads()` runs once after `initChain()`, reports how
   many rows it moved, and the consequence is written down in `docs/SECURITY.md`: a
   downgrade below M1.7 cannot read an upgraded row, and a pre-M1.7 backup is the escape
   hatch. The migration's assertion that the table is empty is also gone — it was not true
   on this development machine, which had one `v1` row.
5. **`projectId` is a string.** The design's `turn_complete` event typed it as a number.
   [Portable identity](docs/PORTABILITY.md#41-every-project-carries-a-uuid) makes a project's
   identity a UUID, so a numeric field there would have had to be changed by M2.2 in a
   table that persists across the change. It is a UUID now, before anything writes one.
6. **There is no `POST /api/notifications/telegram`.** Writing the credentials is
   `PUT /api/secrets` with scope `telegram` — already step-up gated, already audited as
   `secret.changed`, already swept by the sentinel test. A second endpoint performing the
   same two writes is a second thing to gate correctly and a second thing to get wrong, and
   M2.5's UI needs nothing more than what exists. What the route file does carry is
   `GET /api/notifications/telegram` (status: configured, set/unset plus length per value,
   queue counts, drops, last success, last failure category), `POST /api/notifications/test`
   (full session, **no** step-up, `202` with a queue id — a test send reveals nothing, and
   demanding a fresh code to check whether notifications work pushes the operator toward
   not checking), and `GET /api/notifications/queue/:id`.

Two smaller notes that are not departures:

- **`audit.trimmed` is notified on a 24-hour throttle**, not silent. Retention firing is
  also exactly what a tamper would like to look like. A day rather than fifteen minutes
  because once the cap is reached *every* retention check trims again, so a busy panel would
  otherwise send it every few hundred events forever.
- **`notification-rules.ts` is exhaustive over `AuditEvent` by construction.**
  `satisfies Record<AuditEventName, AlertRule | null>` makes a newly added audit event a
  compile error until someone decides whether it notifies, and a silent event carries its
  reason as a comment on an explicit `null` rather than being absent from the table. The
  notified subset is derived back out as a mapped type, so it cannot drift.

**Deferred from M1.7, with reasons:** the inbound hook endpoint and its second loopback
listener (Phase 3 — there is no agent to hook), the resource threshold alerts (they need an
always-on watcher; see §*Built in M1.7* under *Resource usage*), and the M2.5 configuration
UI (there is no client).

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

### Built in M1.7 — and the four places it departs from the design above

The endpoint and the sampler exist as of `feat(m1.7): resource metrics`. Everything above
this line is the reasoning and still stands; these four things are different in the code,
each deliberately.

1. **The route is `GET /api/metrics`, not `GET /api/system/resources`,** and it lives in
   `src/server/routes/metrics.ts` rather than `routes/system.ts`. No reason beyond the
   milestone prompt naming it, and one path is as good as the other — but the shorter one
   is now what the client will call, and `docs/` and this document should say so.
2. **The response is flatter and carries no percentages.** The design's
   `memory.percent`, `cpu.percent` and `disk.percent` are gone; the payload carries the
   numerator and the denominator and the client divides. A percentage is one rounding
   decision and one locale-formatted string away from being a translated value, and the
   two that *are* computed server-side (`cpu.percentOfQuota` and nothing else) exist only
   because they cannot be derived from a single sample. The shape is pinned in
   `MetricsResponse` in `src/shared/types.ts`; `disk.projectsBytes` is also gone, because
   walking `projects/` on a one-second cadence is the display becoming its own load — it
   returns with projects, on its own cadence.
3. **The sampler is poll-driven, not permanent.** The design says "one background sampler
   on a `setInterval` of 1000 ms". It is 1000 ms while someone is polling, and it is
   nothing at all after 60 s with no request. A permanent timer on an idle panel is a
   wakeup a second with no reader, on a platform billed by the second.
4. **Which means the threshold-crossing alerts cannot be built on this sampler**, and are
   therefore not built. A crossing that happens while nobody is polling is a crossing
   nothing observes, so an alert machine bolted to a poll-driven sampler would fire
   *when the operator opens the panel* — the one moment they are already looking. When
   they are built they need their own **always-on** watcher at a low cadence (30 s is
   ample: memory and disk do not cross a threshold in a second, and the CPU rule already
   has a 60 s sustain window), reading the same functions in
   `services/resources.service.ts`, with the crossing state in
   `services/resource-alerts.ts` as designed. The `oom_kill` counter from
   `memory.events` — the most valuable alert of the four, because it is the one that
   already happened — is likewise not read yet, and it is the first thing that watcher
   needs.

### Built in M1.8 — the watcher, and the five places it departs from the design above

The threshold alerts exist as of `feat(m1.8): the resource watchdog`. Everything above this
line is the reasoning and still stands; these five things are different in the code, each
deliberately.

1. **No sustained-CPU rule.** The table above has one (90 % sustained 60 s, clearing at
   70 %) and it is not built. An agent waiting on a model response is *idle*, so CPU is not
   this panel's binding constraint — the row three sections down under *The binding limits
   are memory and the upstream API, not CPU* says exactly that — and a busy agent at 95 % is
   the product working. An alert nobody can act on is what teaches an operator to ignore the
   channel that also carries "someone signed in". The figure is still measured, because it
   is what says what the panel was doing when it died: the run marker carries it and the
   unclean-restart message reads it. **If a CPU rule is ever added it needs the sustain
   window, not just the threshold** — that is the term that makes it mean anything.
2. **The clear threshold is derived, not configured.** The design gives two numbers per
   rule; the code takes one (`PANEL_WATCHDOG_MEMORY_PERCENT`, `PANEL_WATCHDOG_DISK_PERCENT`)
   and derives the other ten points lower. Two settable numbers can be set the wrong way
   round, and `clear` above `alert` is not a hysteresis band but a machine that alternates on
   every sample. The shipped defaults are the design's 85/75 and 80/70 exactly.
3. **Hysteresis is not the whole answer, so there is also a window and an `alerted` flag.**
   The band stops chatter *on the boundary*; a workload genuinely swinging through the whole
   band would still alert on every cycle, so there is a thirty-minute window as well. The
   consequence needed a decision: a crossing whose alert was never delivered must not produce
   a recovery either, because a "back to normal" for something the operator was never told
   about is a message about nothing. So `alerted` is tracked separately from the crossing
   state, and the property is **every alert that was sent gets a recovery, and nothing else
   does**.

   > **Corrected in M2.1 — the window was on the wrong side.** This item shipped as *one
   > alert per rule per thirty minutes*: a cooldown on the **alert**. What that permits, and
   > it is not a corner case:
   >
   > ```
   > t=0   crosses above  -> alert sent
   > t=5   drops below    -> recovery sent
   > t=10  crosses above  -> suppressed by the cooldown
   > t=10+ stays above indefinitely
   > ```
   >
   > The operator's most recent message says "recovered" while the condition is bad, and
   > nothing ever corrects it. A duplicate message is a nuisance; that is misinformation, and
   > it is the failure that teaches an operator to distrust the channel completely. The old
   > paragraph also claimed the cooldown was what made `alerted` necessary, which is now
   > false for a better reason — see below.
   >
   > M2.1 moves the same thirty minutes to the **recovery**: one alert on entering `above`;
   > the rule stays `above` until the reading has been at or below the clear line
   > *continuously* for the clear window; then one recovery, and only then can a new alert
   > fire. `notification_state` gains `memory_clearing_since` and `disk_clearing_since`
   > (migration 011) to hold that run, and `NULL` there is the debounce reset. The invariant
   > it buys is stated as one sentence and asserted as four tests: **the most recent message
   > the operator received always describes the current state of that rule.** A flap is
   > exactly one alert and one recovery. The alert side then needs no throttle at all,
   > because a second alert is unreachable before a recovery.
   >
   > **`alerted` is kept, and it is load-bearing for a different reason.** Nothing swallows
   > an alert any more, but delivery can still fail: a full queue refuses the newest event.
   > So `Watchdog` reads the `EnqueueResult` it already got back and writes `alerted: false`
   > when the enqueue was refused, and the recovery for that crossing is silent. What is
   > *not* wired is a row that queued and then `abandoned` after fifteen attempts — that
   > would mean the notify layer calling back into the watchdog, which the post-commit
   > observer design exists to avoid, and `notification.abandoned` is an audit row and an
   > alert of its own.
   >
   > One more thing came out of the change. `CrossingDecision` now carries **`transition`
   > beside `emit`**, because they are not the same decision: the audit row follows the
   > transition and the Telegram message follows `emit`. Collapsed into one, an undelivered
   > alert left the log saying a threshold was crossed and never saying it cleared — the log
   > lying by omission, in the same way the state machine could. The `cleared` row carries
   > `notified: false` so the pair is checkable from the log alone.
4. **Disk is `(total - available) / total`.** The design says "80 %" without saying of what.
   `available` is `bavail` — the field M2.4's import cap already reads — and the question the
   alert answers is whether the panel can still *write*, for which a block reserved for root
   is not space it has. On a filesystem with a reserve this reads a few points higher than
   `df` for an unprivileged user, which is the conservative direction and is deliberate.
5. **Unclean-restart detection, which is not in the design at all.** The `oom_kill` counter
   can only see a kill the panel *survived*; a kill that takes the container cannot be
   reported by the process that died, and on Railway the restarted container's counter is
   back at zero with `memory.current` looking healthy. So `/data/run/panel.run` is written at
   boot, rewritten with a fresh `lastSeenAt` and the last memory reading every tick, and
   removed by the `onClose` hook — which both signal handlers go through. Present at boot
   means the previous run was not given the chance to shut down, or did not take it.

   **What it can and cannot distinguish, because the wording depends on it.** Railway,
   `docker stop` and a local Ctrl-C all send SIGTERM, and the panel has handlers, so a normal
   redeploy is clean and a SIGKILL is not. What it cannot separate is a container killed for
   memory from a redeploy whose graceful shutdown overran the platform's grace period — both
   are a SIGKILL and both leave the marker. So the message says *did not shut down cleanly*
   and never *crashed*, and it carries the previous run's last memory reading, which is what
   lets the operator tell which it probably was. For this operator that alert is the only way
   an OOM kill on Railway becomes visible at all.

   A file rather than a row, for two reasons that are not style: its *absence* is the signal,
   so it must be readable by a boot that has not opened the database yet — and the crashes
   most worth detecting are exactly the ones that can involve the database or the volume. It
   is also one ~200-byte write every thirty seconds instead of a dirtied page, which is the
   same objection that keeps a write probe out of `/healthz`.

**Independence from the metrics sampler, which is the one thing that had to be right.** The
two consumers call the same reading functions and share no mutable state: every reader is a
pure function of a path, and the CPU rate is `cpuRate(previous, current, quotaCores)`, which
takes the previous sample as an **argument** and remembers nothing. The failure this rules
out is not a crash — one shared slot would make each consumer divide its delta by the other's
interval, and at 1000 ms against 30 000 ms the result is wrong by a factor of thirty while
remaining a plausible number on a dashboard. `tests/unit/watchdog.test.ts` and
`tests/integration/watchdog.test.ts` both point the two at *one* fixture cgroup and assert
they still disagree about the interval, so the assertion is not vacuous.

**The status block, added in M2.1.** `Watchdog.status()` is served as the `watchdog` key of
`GET /api/metrics` rather than from a route of its own: same session, same poll, no new line
in `EXPECTED_ROUTE_TREE`, and no second response shape for the client to learn. It carries
`enabled` (the switch) separately from `running` (the timer), a per-rule `armed` with a
**reason code** — `disabled` / `no_limit` / `unavailable` — the thresholds, the crossing
state, `alertedAt`, `clearingSince`, the OOM counter with a `baseline` flag, this watcher's
own `cpuSampleWindowMs`, and what the run marker said at boot (`checked` separately from
`cleanShutdown`, because *nothing looked* and *shut down cleanly* are different facts). Every
string in it is a code from a closed set or an ISO-8601 timestamp; the exact set of string
leaves is pinned twice in `tests/integration/metrics.test.ts`.

**The client's poll budget, for M2.1.** Two seconds visible, thirty seconds hidden
(`document.visibilityState`), and nothing at all when the tab is closed. Two seconds is
30 requests a minute against a session bucket that refills 240 a minute and holds 120, so
the widget uses an eighth of the refill and never touches the capacity; three tabs at two
seconds is still inside it. The thirty-second hidden cadence is not only politeness — it
is above the sampler's own cadence and below its 60 s idle timeout, so a hidden tab keeps
the sampler warm and `percentOfQuota` stays a number instead of going back to `null` on
every poll. **Back off when hidden, and do not poll a closed tab**: an operator who leaves
the panel open in a background tab for a week should not be generating 30 requests a
minute for a week.

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

### M2 — Phase 2

M1 was delivered as M1.1–M1.7 rather than as one commit, and Phase 2 is the same shape.
**Nothing existing is renumbered:** M1.7 stays where M1.6 put it, and the eight-item list
this section used to hold is now M2.1's content, unchanged in scope.

| # | Goal | Satisfies | Depends on | Blocks M2.1? |
| :--- | :--- | :--- | :--- | :--- |
| **M2.0** | This milestone: the Phase 2–5 architecture, on paper, no code | records R1–R7 | — | it *is* the unblocker |
| **M2.1** | Application shell, design system, and **direction** | R3 | M2.0 | — |
| **M2.2** | Projects: UUID identity, `/data/projects/<uuid>/`, CRUD | R2, foundation for R4/R5/R7 | M2.0 | **yes**, for its decisions only ([§below](#the-decisions-that-block-m21)) |
| **M2.3** | The file browser | R4 | M2.2 | no |
| **M2.4** | `settings.json` documents and provider credentials | R5, R7 | M2.2 | partly — the error-code enum only |
| **M2.5** | Telegram configuration UI | R6 | **M1.7**, M2.1 | no |
| **M2.6** | Portable export and import | R1, R2 | M2.2, M2.4, M1.7 (audit events → rules) | no |
| **M2.7** | The resource widget over the endpoint already designed | earlier requirement | M2.1, `resources.service.ts` | no |
| **M2.8** | Importing an unfinished project: ZIP upload and git clone | R8 | M2.2, M2.3, M2.4, M2.6, `git` in the image | no — but **two of its decisions block M2.2 and M2.4** |

Two ordering facts worth naming rather than discovering:

- **M2.5 cannot ship before M1.7.** The UI configures a transport that does not exist; a
  "test the bot" button with nothing behind it is worse than no button.
- **M2.6 is last on purpose.** An export can only carry what exists, so building it before
  M2.4 would mean writing the document format twice.
- **M2.8 comes after M2.6, not beside it.** M2.6 builds the staging-and-swap pipeline and M2.8
  adds a second arrival path to it. Building both at once is how
  [`docs/IMPORT.md`](docs/IMPORT.md) §2's *one scanner, one classifier, one promoter* rule gets
  negotiated away under schedule pressure — and the path that ends up missing a check is
  always the one used less often, which is the path an unusual project arrives by.
- **Migration numbers are assigned when a milestone is *built*, not when it is designed.**
  M1.7's design claims `009_notifications.sql` and M2.2 needs a migration too; whichever
  lands first takes 009. Re-read the other's design for its number before writing the file.

#### The decisions that block M2.1

Blocking, and I agree with the operator's two:

1. **The project UUID and portable AAD** ([`PORTABILITY.md`](docs/PORTABILITY.md) §4).
   Adding a UUID later is a migration; changing an AAD later is a re-encryption of every
   secret under a scheme the old ciphertext cannot be read back under. Extended by one item
   the operator did not name: **the directory layout is keyed on the UUID too**, and M1.7's
   `secrets:project:<id>:hook_token` becomes `…:<uuid>:…`.
2. **Direction and logical properties** (M2.1 below). Retrofitting direction into a built
   interface costs several times what building it in costs, and the enforcement has to exist
   before the first component, not after the fortieth.

Three more that I think are blocking, and this is the judgement the milestone is for:

3. **A machine-readable `code` on error responses.** R3 makes the server's human strings
   unusable by definition, so the client must map a *code* to a Persian sentence. If
   `lib/api.ts` is written against today's `{ "error": "Forbidden" }`, every screen grows a
   status-code guess and adding `code` later touches every call site. Four lines in
   `app.setErrorHandler` (below), and it must land with the api wrapper.
4. **`t()` returns nodes, not strings.** This is the mechanism that makes §2.3's bidi
   isolation enforceable instead of advisory — a `t()` returning `string` means every
   interpolation of a machine value is a raw concatenation, and there are hundreds of them.
5. **`bootstrap.js` carries the locale**, so `<html dir>` is set before first paint.
   `renderPlaceholderHtml` and `renderBootstrapScript` are exactly what M2.1 replaces, and
   both are asserted byte-for-byte by `base-path.test.ts` and `secret-leak.test.ts` — doing
   it in the same pass is free, and doing it later is a second pass over those tests.

And two that R8 added on 2026-09-05, both blocking a milestone rather than M2.1:

6. **The `projects` provenance and review columns, in migration `012`, with M2.2.**
   [`docs/IMPORT.md`](docs/IMPORT.md) §10. `origin`, `origin_ref`, `origin_at`,
   `source_install_id`, `review_state`, `reviewed_at`, `artefacts_json`. The one that is easy
   to argue away is `review_state`, and it is the one that matters: whether anybody has looked
   at what an imported project will do is not UI state, it is false by default for everything
   imported, and it is read by the projects list, the spawn confirmation and the export dialog.
   A `NOT NULL` column added later has to invent a value for every existing row, which is how a
   provenance field ends up meaning "created here, probably".
7. **Four settings-model changes, with M2.4.** [`docs/IMPORT.md`](docs/IMPORT.md) §11:
   `.claude/settings.local.json` is in the precedence chain and not in M2.4's model;
   `.mcp.json` is a separate root file and not in it either; per-key provenance needs
   `workspace` and `workspace_local` as **sources** rather than as a "shadowed by" modifier;
   and `hooks.Stop` cannot be panel-owned through the user-level file, so the panel's
   non-negotiable keys want `claude --settings`. Retrofitting the provenance enum is a change to
   every row of every settings screen.

**Not blocking, explicitly:** the export format, the containment function, the credential
test, the Telegram UI, every retention sweep, and every part of R8 that is not in the two items
above. All are additive behind their own routes, and none of them constrains a component's
shape.

#### M2.1 — application shell, design system, and direction

The eight items as they always were, plus R3 built in from the first line rather than
retrofitted:

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
9. **Commit:** `feat(m2.1): application shell and design system`

##### Built in M2.1 — and the seven places it departs from the list above

Delivered as six commits (Part 0 through Part 5) rather than one, so that a blank page can be
bisected — the first milestone in this project whose mistakes are invisible to the test suite.
`docs/UI.md` is the authority for the result; these are the departures.

1. **Plain CSS, not a Tailwind theme** (item 1). Decision 23 above has the argument: the
   logical-property scan is exact over CSS declarations and unsound over `className` strings.
2. **No command palette** (item 3). It has nothing to search until there are projects — the
   only things it could offer are the five links already on screen, and a palette that lists
   five links teaches the operator not to open it. Recorded for M2.2.
3. **No SetupWizard or Projects page** (item 4). There are no projects yet, and the "setup
   wizard" is the enrolment flow inside the sign-in screen, which is where a fresh install
   actually meets it. The four screens built are Sessions, Security, Secrets and Audit, plus
   the Overview that carries the resource widget.
4. **The router is hand-written** (item 5), not a dependency. Five routes; the two features
   React Router would supply are a `basename` and a catch-all.
5. **No light theme** (item 6). `color-scheme: dark` and one accent. A light theme is not a
   token swap in a panel whose accent has to stay legible beside a terminal, and inventing one
   before Phase 3's terminal exists would be inventing it twice.
6. **No Inter** (§*Fonts*). Vazirmatn's own Latin companion is designed against its Arabic
   metrics, and every technical value in this panel is Latin sitting inside a Persian sentence.
   Shipping both would mean one font that never renders a glyph.
7. **No QR renderer.** The `otpauth://` URI and the secret are shown in copyable blocks, and
   the screen says why: the image would have to be built from the secret, and a camera does
   nothing typing cannot. `qrcode` was a runtime dependency nothing imported and is removed.

Two things it added that the list did not ask for, both because the alternative was worse:

- **A diagnostic shell.** When there is no usable client bundle the prefix root serves a page
  that says so and names the command, rather than a blank page or a 500. The API, the CLI and
  `/healthz` all work without a client, and a panel that refused to boot because its front-end
  was missing would take away the one interface that could have said so.
- **A `users.locale` column and `PATCH /api/settings/locale`** (migration 011), which §R3
  specified and the item list did not mention. Null is not `'en'`; the route needs a full
  session and no step-up, and is the one write in the panel with no audit row.

##### R3: Persian and English, decided before the first component

**Persian is right-to-left, which is a layout problem and not a string problem.** The
mechanisms below all exist to make one property true: direction is a *setting*, not a
rewrite.

**Logical properties, from the first line.** Every component uses
`margin-inline-start` / `padding-inline` / `inset-inline-start` / `text-align: start`, and in
Tailwind v4 that means the logical utilities — `ms-` `me-` `ps-` `pe-` `start-` `end-`
`text-start` `text-end` `border-s` `border-e` `rounded-s` `rounded-e` — never `ml-` `mr-`
`pl-` `pr-` `left-` `right-` `text-left` `text-right` `border-l` `border-r`. Physical sides
are permitted only where the thing has a physical side (a drop shadow's offset, an icon that
means "down"), and each one is listed in an allowlist file with a reason.

Enforced by **a static scan test in the same style as `cookie-discipline.test.ts`** — no new
tooling, and the project already trusts that mechanism — over `src/client/**`, matching the
physical utilities in `className` strings and the physical properties in CSS. Anything not in
the allowlist is the finding. This is the check that stops the rule rotting on component
number forty.

**Islands that stay left-to-right in both languages, always.** `dir="ltr"` on the container,
never on the page:

> the terminal; any code or JSON editor; file paths; the base path; tokens, hashes and commit
> ids; log output and audit metadata; the memory, CPU and disk readouts; durations and byte
> counts; the file browser's breadcrumb.

A terminal that flips direction is unusable, and the bug does not read as a layout setting —
it reads as data corruption, which is a support conversation that starts in the wrong place.
Mechanism: one `<Ltr>` element and a `<Mono>` that includes it; the scan test asserts the
terminal and editor containers carry it.

**Bidirectional isolation on every interpolated machine value.** A Latin value inside a
Persian sentence reorders visually unless it is isolated, because the neutral characters at
its edges — `/` `.` `-` `:` `(` — resolve to the *paragraph's* direction rather than the
run's. Use `<bdi>`, which is `unicode-bidi: isolate` plus `dir="auto"` by definition.
(`dir="auto"` on a `<span>` is equivalent; `<bdi>` is the element that means it.)

```
t('files.savedTo', { path: '/data/projects/9f8e/workspace' })

raw (stored, unchanged):   پروژه در {path} ذخیره شد
without isolation, displays:  … data/projects/9f8e/workspace/ …   ← the leading "/" jumped to the far end
with <bdi>, displays:         … /data/projects/9f8e/workspace …   ← the run is isolated
```

The string on disk is identical in both cases; only the visual order differs — which is
exactly why this reads as a data error and gets reported as one. **This is the single most
common Persian-UI bug**, so it is not left to discipline: `t()` with parameters returns a
`ReactNode`, not a string, and wraps every parameter in `<bdi>` itself. A machine value
*cannot* be concatenated raw, because there is no string to concatenate into.

**The server does not translate.** The API returns machine-readable codes and the client owns
every human string. That is unchanged for status text — `app.setErrorHandler` still sends only
the status's standard reason phrase — and it gains one field: an optional **`code` from a
closed enum**, for the errors a client must distinguish (`csrf_invalid`, `stepup_required`,
`rate_limited`, `stale_version`, `path_rejected`, `too_large`, `bad_passphrase`,
`unsupported_format_version`, …). Never a message, never a variable, never a value. This
*reduces* leak surface rather than adding to it: the alternative is a client guessing from
status codes until someone is tempted to put prose in the body. The existing rule and its
regression test stand.

One exception, and it is M1.7's: **Telegram messages have no client**, so the queued
`NotifyEvent` carries a `locale` and the renderer produces text in it. That is the notification
layer rendering its own transport's output, which the typed-event design already requires; it
is not the API translating.

**Mechanics: a typed dictionary and a `t()`, not a framework.** `src/client/i18n/en.ts` is the
source of truth, `type Dict = typeof en`, and `fa.ts` is declared `const fa: Dict` — so an
absent or misspelled key is a **compile error**, not a test failure. The test covers what types
cannot: identical key sets at runtime (catching a `fa` built with `as Dict`), no empty string
values, and no key whose Persian value still equals its English one for text that must be
translated. Specified now, written in M2.1.

- **The choice is stored on `users`** (`locale TEXT`, nullable, migration 011), returned by
  `GET /api/auth/me`, set by `PATCH /api/settings/locale`. There is one user, so a column is
  the honest place; `config/instance.json` is for facts the installer set.
  - **Null is not `'en'`**, and the distinction is what makes a Persian browser's first visit
    Persian: null means *never chosen*, so the `Accept-Language` guess is still in force, and
    `'en'` means *chose English*, which overrides the header. Collapsing them would make the
    guess unreachable the moment a row existed.
  - **`PATCH` needs a full session, and deliberately no step-up.** A language is not a
    security control, but it is a write to the `users` row and a `pre` session must not be able
    to make one — so the toggle on the login screen works entirely client-side, storing the
    choice in `localStorage` where `bootstrap.js` reads it on the next load. An unauthenticated
    visitor can change what their browser shows and cannot change what the panel stores. It is
    also the one write in the panel with **no audit row**: the log records what an attacker
    could do with a stolen session, it is capped, and a row per language toggle costs the
    oldest real row.
  - **This row is what M2.5 should read for the notification locale.** `PANEL_NOTIFY_LOCALE`
    then becomes the initial default for one stored value rather than a second independent
    setting — which is decision 16 above, and this column is the place it lands.
- **First guess from `Accept-Language`**, resolved server-side and emitted into
  `bootstrap.js` as `window.__LOCALE__` — which is already generated per request and already
  `no-store`. The script runs in `<head>`, blocking, before the module bundle, so it sets
  `document.documentElement.lang` and `.dir` **before first paint**.
- `bootstrap.js` deliberately does **not** read the session to find the stored locale: that
  would put a database read on an unauthenticated route, which `routes/api.ts` avoids on
  purpose. The stored value is cached in `localStorage` and applied by the same script, so the
  only wrong-direction frame anyone ever sees is on a brand-new browser profile whose
  `Accept-Language` disagrees with the stored preference. That is the right trade.

**Fonts.** Inter does not cover Persian. Pair it with **Vazirmatn** (SIL OFL 1.1, maintained,
designed for UI, has a variable weight axis and a matching Latin companion). Alternative:
Estedad. *Not* IRANSans — its licence does not permit redistribution, and this must be served
from the panel because `font-src 'self'` has no CDN in it. Subset to Arabic, Arabic
Supplement, Arabic Extended-A, Arabic Presentation Forms A/B and Persian punctuation; split by
`unicode-range` so an English-only page never downloads it. Subsetting happens at development
time and the `woff2` is committed, like the existing plan for Inter — the runtime image has no
Python and is not getting one.

**Formatting.** Timestamps are stored as ISO-8601 UTC and formatted through
`Intl.DateTimeFormat` with the active locale, which gives an Iranian operator a Jalali date
with no calendar library. Two formatters, and the distinction is load-bearing:

| | Locale used | For |
| :--- | :--- | :--- |
| `formatNumber`, `formatDate` | `fa-IR` / `en-GB` as chosen | prose quantities and dates in body text |
| `formatTechnical`, `formatTechnicalDate` | `fa-IR-u-ca-persian-nu-latn` | everything in a `dir="ltr"` island |

**Latin digits for every technical value in both languages** — the operator's recommendation,
and the reason is copy-paste equality. `fa` defaults to `arabext` numbering, so
`Intl.NumberFormat('fa-IR').format(8080)` yields `۸۰۸۰`: a port number that does not match the
terminal, a byte count that will not `grep`, a commit id that is not the commit id. `-nu-latn`
is not cosmetic, it is what keeps a number the same number on both sides of a clipboard. The
Jalali *calendar* is kept (`-ca-persian`) because a date is read, not pasted.

#### M2.2 — projects: identity, layout, and CRUD

The table, the layout and the AAD form are specified in
[`docs/PORTABILITY.md`](docs/PORTABILITY.md) §4 rather than repeated here, because they
exist for R2 and are only *used* by everything else. In brief: `projects` gains
`uuid TEXT NOT NULL UNIQUE` (`crypto.randomUUID()` at creation), the workspace lives at
`/data/projects/<uuid>/workspace` with `claude-home/` beside it, and every project-scoped
secret is bound to `secrets:project:<uuid>:<name>` under M1.7's `v2` payload version.

Also here, because it is cheap now: `slug` (unique after NFC normalisation and case folding),
`display_name`, `description`, `git_remote`, `created_at`/`updated_at` as **ISO-8601**
(`isoFrom`, not `datetime('now')` — see the note under M2.4 §*storage*), and the per-project
hook token from M1.7.

**And R8's provenance and review columns, which are not optional here.**
[`docs/IMPORT.md`](docs/IMPORT.md) §10 specifies them: `origin`, `origin_ref`, `origin_at`,
`source_install_id`, `review_state`, `reviewed_at`, `artefacts_json`. They are in *this*
migration because a column added to `projects` later is an `ALTER` against a live volume with
the operator's projects in it — and a `NOT NULL` provenance column added then has to invent a
value for every existing row. R8's *per-item* approval table is the other side of that line and
lands with R8: adding a table later is free.

The migration is **`012`**. M1.7 took `009`, M1.8 took `010` and M2.1 took `011`, by the rule
that a number is claimed by the commit that lands.

**Commit:** `feat(m2.2): projects`

#### M2.3 — the file browser

Specified in [`docs/FILES.md`](docs/FILES.md). The containment function
(`utils/contain-path.ts`) is shared with the import path, so it lands here and M2.6 uses it
rather than growing a second one.

**Commit:** `feat(m2.3): the project file browser`

#### M2.4 — `settings.json` documents and provider credentials (R5, R7)

##### The file the panel writes is generated, not edited

Claude Code resolves settings through a precedence chain — highest first: **managed
settings**, `claude --settings`, `.claude/settings.local.json`, `.claude/settings.json`,
`~/.claude/settings.json` (verified against `code.claude.com/docs/en/settings` on
**2026-09-03**). A panel that edits the wrong file in that chain appears to work and changes
nothing, which for a beginner is an unfindable bug.

##### `--settings` layers, and the reassuring half is not the important half

Confirmed on **2026-09-05** (documentation plus the surrounding issue history), because M2.4's
generator depends on it and finding out late is expensive. **The chain is a merge, not a
selection.** For a scalar key, the highest-precedence file that defines it supplies the value;
**arrays are concatenated and de-duplicated across scopes**; objects are deep-merged.
Documented exceptions that do *not* merge — `fallbackModel`, `availableModels`, `modelPicker`,
`modelSettings`, `claudeMdExcludes` — where the highest-precedence file that defines the key
supplies the whole value. Permission rules merge across scopes, with `deny` beating `ask`
beating `allow`.

Four consequences, and they point in different directions:

1. **Passing `--settings` does not discard the operator's own user-level settings.** The
   opposite-and-worse failure — the panel silently deleting their configuration — is not a
   real risk.
2. **The panel *can* outrank a workspace file** for any scalar, and for any individual key of
   a deep-merged object, including `env.ANTHROPIC_BASE_URL` and `env.ANTHROPIC_AUTH_TOKEN`.
   That is the mechanism the generator should use — a generated file passed with `--settings`,
   at level 2 — rather than relying on the user-level file `CLAUDE_CONFIG_DIR` relocates,
   which is the *lowest* of the five.
3. **It does not make the executable class safe, and this is the half that matters.** `hooks`
   is array-valued, so an uploaded `hooks.Stop` is **concatenated with the panel's rather
   than outranked by it — it still runs**. `mcpServers` is deep-merged, so an uploaded server
   is *added*, not replaced. `permissions.allow` merges. **Every key in R8's executable and
   permission-widening classes is a key that merges**, which is precisely why the class
   exists and why stripping it stays mandatory ([`docs/IMPORT.md` §5.3](docs/IMPORT.md)).
4. **Merge semantics are a property of a release.** The exception list and the same-name
   rules changed at named versions (v2.1.175, v2.1.228, v2.1.242). **Rely on them for
   convenience; never for a security property.** Folder trust must never be the reason a
   class is treated as safe.

**Net effect on the claim in the paragraph below:** it becomes nearly true, for a different
reason than either side of the argument had. A workspace `hooks.Stop` cannot *remove* the
panel's, because hooks concatenate — both fire. So the turn-complete notification survives a
hostile workspace file. What it does not survive is **the panel not passing `--settings` at
all**. The verification requirement stands and is M2.4's: before the generator is written,
confirm the behaviour against a temporary config dir with a deliberately conflicting
`hooks.Stop` in a scratch workspace, and **record the observed behaviour and the Claude Code
version next to the claim.**

Two consequences, and the second one is not obvious:

1. The panel's per-project `CLAUDE_CONFIG_DIR` is `claude-home`, so the file it writes is that
   project's **user-level** file — the *lowest* precedence in the chain. A
   `.claude/settings.json` committed in the operator's own repository silently overrides it.
   The panel must therefore compute and display the effective merge, and **warn by name** when
   a workspace file shadows a key the panel set. That is what turns "shows the merged result"
   from a nicety into the check that catches the panel's own weakest position.
2. `CLAUDE_CONFIG_DIR` *replaces* `~/.claude`, so a per-project config dir means the panel's
   **global** `settings.json` is not in that project's chain at all. R7's "global default"
   therefore **cannot** be implemented by Claude Code's precedence — it is the panel's job.

So the model is three documents and one artefact:

| | What | Who writes it |
| :--- | :--- | :--- |
| `global_settings.settings_json` | the operator's hand-edited global JSON (R7) | the operator, in the panel |
| `project_settings.settings_json` | the operator's hand-edited per-project JSON (R5) | the operator, in the panel |
| credentials | `api_key`, `api_base_url`, `auth_style`, per project and global (R7) | the operator, in the panel |
| `<claude-home>/settings.json` | **generated** from all three plus the hook config, at every spawn, atomically, mode `0600` | the panel only |

The editor names the exact file it writes, shows where that file sits in the chain, and shows
the generated result beside the source document with **per-key provenance** (`global` /
`project` / `panel` / *shadowed by `workspace/.claude/settings.json`*). The generated file is a
build artefact: hand-editing it is overwritten at the next spawn, and the UI says so on the
file rather than in a tooltip.

Merge rules, because "merge" is not a specification: shallow at the top level with project
winning, except `env` (merged key by key, project wins per key) and
`permissions.allow`/`deny`/`ask` (concatenated, de-duplicated, order preserved). `hooks.Stop`
is panel-owned and is written last, overwriting whatever either document said, and the UI
explains why that key is not theirs.

> **Corrected on 2026-09-05 by R8.** This paragraph used to end *"the operator cannot break the
> turn-complete notification by hand"*, and that is **false**. "Written last" is about the order
> in which the panel merges its own two documents into the generated file — and the generated
> file is the *user-level* file, the lowest level of the chain, while a workspace
> `.claude/settings.json` is above it and `.claude/settings.local.json` above that. So a project
> carrying its own `hooks.Stop` silently replaces the panel's: the feature looks configured, the
> queue stays empty, and M2.5's dead-channel banner correctly reports a healthy channel with
> nothing in it. The fix is to pass the panel's non-negotiable keys with `claude --settings`,
> which is level 2 and outranks both workspace files, plus a named warning either way.
> [`docs/IMPORT.md`](docs/IMPORT.md) §11.4 has the argument, the two rejected alternatives, and
> the one thing that must be verified before the generator is written.
>
> **Refined on 2026-09-05 by the `--settings` answer above.** `hooks` is array-valued and
> **merges across scopes**, so a workspace `hooks.Stop` does not replace the panel's — both
> fire, and the turn-complete notification survives. The failure mode is therefore not "the
> operator broke it by hand" but "the panel never passed `--settings`". The fix is unchanged;
> the reason it works is different, and the same merge behaviour is exactly why R8's
> executable class cannot be made safe by precedence.

**Three more things R8 requires of this model**, all of them cheaper now than after the settings
screens exist ([`docs/IMPORT.md`](docs/IMPORT.md) §11): `.claude/settings.local.json` is in the
precedence chain and is not mentioned anywhere above; `.mcp.json` is a separate file at the
project root and is not part of `settings.json`, so the effective-merge view has a hole exactly
where the executable class lives; and per-key provenance needs `workspace` and `workspace_local`
as **sources** rather than a *shadowed by* modifier, because a key that exists only in a
workspace file has no panel-side provenance at all and rendering it as "not set" is precisely the
failure this view exists to catch.

Invalid JSON is refused **at save time** on the source document, which is where 4.7's failure
mode is actually prevented. Unknown top-level keys are a warning, not a refusal. Once Phase 3
installs the CLI, `claude doctor` becomes a real "check this" action.

##### Credentials never go in the workspace

**The most important line in this milestone.** `api_key` and `api_base_url` are written only
into `claude-home`. If they went into `workspace/.claude/settings.json` they would land inside
the operator's git repository and could be committed and pushed — and the panel would have
been the thing that put them there. `claude-home` is outside the repository, outside the file
browser's root ([`FILES.md`](docs/FILES.md) §1), and excluded from the export's workspace
walk.

There is a second, mechanical reason that reinforces it: env values arriving from *project or
local* settings are gated on folder trust and, for credential-shaped values, on an approval
dialog. The user-level file the panel writes is not.

The editor warns — loudly, in the save dialog, not in a log line — when a workspace file the
operator hand-writes contains something credential-shaped, reusing the patterns in
`plugins/logger-redaction.ts`. It does not refuse: it is their repository.

##### The resolution chain, and showing it honestly

Per-project value → global default → nothing at all, and "nothing at all" means the panel
writes no key and the agent uses whatever it already had. The UI must not let **inherited**
and **set to the same value** look alike, because they behave differently the moment the
global changes:

```
api_base_url   https://gw.example.com/v1     inherited from global   [override]
api_key        set, 51 characters            set for this project    [replace] [clear]
```

An inherited row is visually secondary and names its source; an overridden row that happens to
equal the global says `set for this project (same as global)`. One word, and it is the
difference between a change propagating and not.

##### Two header styles, and this one is specific to this operator

`ANTHROPIC_API_KEY` is sent as **`X-Api-Key`**; `ANTHROPIC_AUTH_TOKEN` is sent as
**`Authorization: Bearer <value>`** (the prefix is added by Claude Code). Choosing wrong
yields a `401` indistinguishable from a bad key. So the UI asks, explicitly, with a
plain-language hint: first-party Anthropic and resellers that issue `sk-ant-`-shaped keys want
the API-key style; gateways that front other providers, and anything whose documentation says
"Bearer", want the token style.

Three facts that belong on that screen, all verified 2026-09-03 against
`code.claude.com/docs/en/env-vars`:

- **Never set both.** Credential resolution is `ANTHROPIC_API_KEY` first, then
  `ANTHROPIC_AUTH_TOKEN`; setting both silently selects the API-key path. The panel writes
  exactly one, and clearing one clears the other's key from the generated file.
- `ANTHROPIC_API_KEY` **prompts for approval once, interactively**, before it overrides a
  logged-in subscription. The first spawn of an API-key project therefore shows a prompt the
  operator must answer in the terminal — so the terminal must be visible on first spawn, not
  behind a spinner. `ANTHROPIC_AUTH_TOKEN` has no such prompt, which is a real reason to prefer
  it where the provider accepts either.
- A non-first-party `ANTHROPIC_BASE_URL` disables MCP tool search by default
  (`ENABLE_TOOL_SEARCH=true` re-enables it if the gateway forwards `tool_reference` blocks) and
  disables Remote Control. Both are consequences of R7 that should be stated in the UI rather
  than discovered.
- `ANTHROPIC_CUSTOM_HEADERS` (`Name: Value`, newline-separated) is the escape hatch for a
  gateway that wants some third header. Offered, not featured.

**"Test this credential"** makes real requests and reports the real result:
`GET <base>/v1/models` first, falling back to `POST <base>/v1/messages` with `max_tokens: 1`
for gateways that do not implement `/models`; and it tries **both `<base>` and `<base>/v1`**,
reporting which one answered and offering to save the normalised value — because the trailing
`/v1` has already cost this operator time. 10 s per probe, 20 s total, first success wins.
Outcomes are categories, never the provider's response body (which can echo request headers):
`ok` · `unauthorized` · `not_found` (wrong base URL, or the missing `/v1`) ·
`wrong_header_style` (the other style succeeded where this one did not — detectable precisely
because both are probed) · `unreachable` · `timeout` · `rate_limited` · `server_error` ·
`not_anthropic_shaped`. It needs **M1.7's `PANEL_OUTBOUND_PROXY` / `ProxyAgent` plumbing**,
because Node's `fetch` ignores `http_proxy` and this machine sets it — without that, the test
fails in local development for a reason that has nothing to do with the credential.

##### How the value reaches the running agent

Both mechanisms, written by **one** function so they cannot disagree: the `env` block of the
generated `settings.json`, and the process environment of the pty.

The reason is not the one that is usually given. **The settings file's `env` block wins over
the shell** — documented and deliberate: *"Claude Code writes each `env` entry into the process
environment, replacing the value inherited from the shell."* So the file is the authority and
the environment export is the belt: it covers tools that read the variable directly, and the
case where the config dir is not where the panel thinks it is. The prompt for this milestone
described the opposite as a regression; the current documentation says the file winning is the
design, and the conclusion — write both — is unchanged either way.

What the UI must tell the operator, precisely:

- **Setting or changing** a value reaches a **running** session when the file is saved, so the
  panel rewrites the generated file for live agents too and the change lands without a restart.
- **Clearing** one does not: a variable removed from the file is not unset in a running
  session. *That* is the case that needs "restart the terminal", and it is the only one.
- `permissions`, `hooks` and `apiKeyHelper` reload live. `model`, `effortLevel` and
  `outputStyle` are read once at session start.

##### Storage and the leak surface

Encrypted with the existing crypto module, `v2` payload, AAD `secrets:project:<uuid>:api_key`
and `secrets:global:api_key`. `auth_style` and `api_base_url` are configuration, not
credentials — but `api_base_url` can carry a token in a query string on some gateways, so it is
stored encrypted too and displayed in full only in the editor.

Then the honest part: **the panel must also write the key in plaintext into a `settings.json`
on the volume**, because that is where Claude Code reads it from. Mitigations, all of them
mechanical: mode `0600` in a `0700` directory; inside `claude-home`, so outside both the file
browser's root and the git repository; never in any export (the export carries the credential
from the database and the target regenerates the file); and never in `npm run backup`, which
copies only `panel.db`.

**The sentinel sweep grows a filesystem half.** `tests/integration/secret-leak.test.ts` today
reads `panel.db`, `panel.db-wal` and `panel.db-shm`. It must additionally assert that a
sentinel credential written through the new routes appears in **exactly one** place on the
volume — the generated `claude-home/settings.json` — and nowhere else: not in the three
database files, not in any workspace file, not under `/data/exports`, not in a log line. The
exemption is an explicit allowlist and must be asserted **non-vacuous** (the generated file
really does contain it), exactly as the base-path exemption already is, so it cannot quietly
grow to cover a real leak.

One existing bug this milestone must fix, found while reading: `secrets.created_at` and
`updated_at` are written with SQLite's `datetime('now')`, which yields
`2026-09-03 09:14:22` — UTC with **no zone designator** — and `GET /api/secrets` puts it
straight on the wire. Every other timestamp the panel serves goes through `isoFrom()` and ends
in `Z`. `new Date('2026-09-03 09:14:22')` in a browser is parsed as **local** time, so the
secrets list would be the one screen in the panel whose times are wrong by the operator's UTC
offset — +03:30, and hidden further by a Jalali calendar. One line in
`SecretsRepository.set()`, plus a normalising `UPDATE` in this milestone's migration.

##### Rollback

Versioned **source documents**, not the generated file — restoring a build artefact would be
undone by the next spawn. A `settings_versions` table keeps the last 10 revisions of each
hand-edited document (global and per project) with `saved_at` and a `sha256`, a diff view, and
one-click restore. Since invalid JSON is refused at save time, this is the safety net for the
valid-but-wrong document: a `permissions.deny` that blocks the tool the agent needs, an `env`
key that points at the wrong gateway.

**Commit:** `feat(m2.4): settings documents and provider credentials`

#### M2.6 — portable export and import

Specified in [`docs/PORTABILITY.md`](docs/PORTABILITY.md).
**Commit:** `feat(m2.6): portable export and import`

#### M2.8 — importing an unfinished project (R8)

Specified in [`docs/IMPORT.md`](docs/IMPORT.md). Two arrival paths — a ZIP upload and a git
clone — and **one** pipeline from staging onward, enforced by a static scan rather than by
review. The feature's honest name is *surface, review, neutralise*: with a per-project
`CLAUDE_CONFIG_DIR`, a workspace `.claude/settings.json` already outranks everything the panel
writes, so an uploaded project's settings do not need to be adopted in order to take effect —
they already will, and today they would be neither visible nor governed.

**Commit:** `feat(m2.8): importing an unfinished project`

#### M2.7 — the resource widget

The server side is already designed under
[Resource usage](#resource-usage--the-server-side-design); M2.7 is the widget over it. **The
crossing-alert state machine is no longer part of this milestone** — it was built in M1.8,
because a poll-driven sampler cannot observe a crossing while nobody is polling and the
panel could otherwise report a failed login and not an OOM kill. What M2.7 inherits is
`Watchdog.status()`: whether each rule is *armed*, its thresholds, its current state, and the
OOM counter — **served as the `watchdog` key of `GET /api/metrics` since M2.1**, which also
built the first version of the widget over it (M2.1 Part 4). M2.7 is the polish pass, not the
first render. Showing "memory alerting: disabled — this container has no memory limit" is part
of the widget, not a footnote: a rule with no denominator is disabled rather than healthy, and
the boot log and `npm run preflight` are the only places that say so today. Every figure in it is a `dir="ltr"` island with
`formatTechnical`, and a `null` limit renders as a used-only figure with no bar — which is the
requirement that section exists for.
**Commit:** `feat(m2.7): resource widget`

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
