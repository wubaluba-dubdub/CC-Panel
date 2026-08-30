# Claude Code Control Panel — Phase 1

## Overview
This document describes the architecture, security model, directory layout, and conventions for the Claude Code Control Panel (single-user, Railway-hosted) as built in Phase 1.

**Important filesystem note**: The project now lives at `/home/hossein/projects/cc-panel` on the WSL2 Linux filesystem. It must never be moved back under `/mnt/`. Development runs as the non-root Linux user "hossein", not root.

## Security Model
- **Single user**: Only one admin user exists, seeded via environment variables on first boot.
- **Defense in depth**:
  - Obscurity via secret base path (not a security boundary).
  - Strong authentication (password argon2id + TOTP 2FA).
  - Progressive lockout (per-IP and per-account) persisted in SQLite.
  - Server-side sessions with opaque tokens, SHA-256 hashed in DB.
  - CSRF protection via double-submit token + SameSite=Strict cookies.
  - Strict Origin validation on mutating requests and WebSocket upgrades.
  - Response headers: CSP, HSTS, etc. (see below).
  - Secrets at rest encrypted with AES-256-GCM using HKDF-derived subkeys.
  - Audit log append-only, no secrets in meta.
  - Rate limiting and request size limits.
  - Boot-time self-checks refuse to start if critical misconfigurations.

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
- Database tables: `users`, `sessions`, `audit_log`, `secrets`, `lockouts`.

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
1. **First boot**: Seeded user created from `PANEL_ADMIN_USERNAME` and `PANEL_ADMIN_PASSWORD`.
2. **Setup wizard**: Forces TOTP setup (QR + manual entry) and displays 10 recovery codes once.
3. **Login**: Username/password → TOTP challenge. Argon2 verification runs even for non-existent user (using dummy hash) to prevent user enumeration.
4. **Step-up**: Required for sensitive actions (password change, secret reveal, etc.) — password + TOTP valid for 5 minutes.

## Sessions
- Opaque random tokens (32 bytes), stored as SHA-256 hash in SQLite.
- Cookie: `HttpOnly; Secure; SameSite=Strict; Path=/${basePath}`.
- Idle timeout: 8 hours with sliding renewal.
- Absolute maximum: 30 days.
- Sessions page lists active sessions with revoke options.

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
- Table: `audit_log` (id, ts, event, actorIp, userAgent, outcome, metaJson).
- Events include: setup completed, login success/failure, 2FA failure, lockout triggered, session created/revoked, secret revealed/changed, settings written, base path regenerated.
- `metaJson` is validated to contain no secrets.

## Rate Limiting
- Global per-IP token bucket on all routes.
- Tighter bucket on login and secret reveal endpoints.

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
- **M1.4 — authentication: not started.** Password hashing, sessions, TOTP,
  recovery codes, CSRF, `Origin` validation, lockout, rate limiting, audit log.
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