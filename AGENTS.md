# AGENTS.md — Claude Code Control Panel

Authoritative docs: `CLAUDE.md` (architecture, security model, conventions) and
`PLAN.md` (milestone order, numbered decisions, recorded divergences).
**This file is a summary and a set of hard constraints. It is not a replacement.**
Before starting any milestone, read the relevant sections of both files.

Phase 1 was implemented by a different model. The design is deliberate and
frequently departs from common defaults. Those departures are load-bearing and
are documented with reasons. Do not "modernise", "clean up", or "improve" them.

## Working agreement

- Do exactly the task asked. Do not touch files outside its scope.
- If you believe a documented decision is wrong: say so and stop. Do not
  unilaterally change it. The operator decides.
- Terminal output is the source of truth. Never report success without it.
- Before claiming any task complete, all three must pass:
  `npm run typecheck && npm test && npm run lint`
- `npm test` must print `RUN v4.x`. Anything else means the wrong vitest.
- `npm audit --omit=dev` must report 0 vulnerabilities. Non-zero is a build
  failure, not a warning.
- Never commit `.env`. New env vars go in `.env.example` and are `PANEL_*`.
- Do not rewrite `PLAN.md`'s Phase 1 file tree. It is kept unedited as the
  record of the original plan; divergences are recorded in milestone entries.

## Environment

- Project lives at `/home/hossein/projects/cc-panel` on the WSL2 Linux
  filesystem. Never move it under `/mnt/`. Never assume root; the dev user is
  `hossein`.
- Container filesystem is ephemeral. All persistent state is under `/data`
  (`panel.db`, `home/`, `config/instance.json`, `global/claude-home/`,
  `projects/`, `exports/`, `run/panel.run`, `logs/`).
- Server build is `tsc -p tsconfig.build.json`. Two tsconfigs: server has node
  types and no DOM, client has DOM and cannot reach `node:fs`.
  `npm run typecheck` runs both.
- Deployment configuration lives in `.railway/railway.ts`; `railway.json` no
  longer exists.

## Hard constraints (each is enforced by a test — expect a red suite)

1. **No per-IP logic anywhere. No lockout.** Nothing in the auth path may
   branch on, rate-limit by, or store counts against the client address.
   The address is display-only metadata. `src/server/utils/client-ip.ts` is the
   single place it is read. Replacement mechanism is a global consecutive-failure
   counter driving a target response time, with single-flight execution.
   Enforced by `tests/integration/no-ip-decisions.test.ts`, which scans every
   file under `src/server` for `req.ip`, `remoteAddress`, `socket.remote*`,
   `x-forwarded-for`, asserts the `lockouts` table stays dropped, and asserts
   `auth_failures` has no `scope` or `ip` column.
   Rationale: the operator connects through tunnels with rotating addresses, and
   a lockout on a single-user panel is a DoS primitive. With `PANEL_TRUST_PROXY`
   on, the address is attacker-supplied input.
2. **Rate limiting carries no address**: one shared anonymous token bucket, one
   per session, plus request size and receipt-time limits.
3. **No secret may reach a log line, a `Referer`, or an error body.** The secret
   base path in particular. Audit metadata validation *throws* on anything
   secret-shaped. Enforced by `tests/integration/secret-leak.test.ts`, which also
   pins the route tree via `EXPECTED_ROUTE_TREE` — a new route must be added
   there deliberately.
4. **Client is pure CSS.** No Tailwind, no CSS-in-JS, no UI component library.
   Enforced by `tests/unit/client-style.test.ts` and
   `tests/unit/client-discipline.test.ts`. TODO(verify): confirm exact filenames
   and the full rule set from `CLAUDE.md`.
5. **All outbound HTTP goes through `src/server/utils/outbound-http.ts`.** Node's
   global `fetch` ignores `http_proxy`/`https_proxy`; `api.telegram.org` is
   unreachable from the operator's country without a proxy, so an explicit
   `undici` `ProxyAgent` is required and the standalone package's dispatcher must
   not be paired with Node's built-in `fetch`. Enforced by
   `tests/unit/telegram-transport.test.ts`.
6. **`Server` and `X-Powered-By` headers stay absent.** Regression test exists.
7. **CSP ships `connect-src 'self'` with no explicit `wss:`.** Do not add it
   pre-emptively. In Phase 3, verify the terminal WebSocket in a real browser and
   only add `wss://<self>` if it actually fails. The WebSocket upgrade handler
   must call `validateRequestOrigin` itself — a raw HTTP upgrade never becomes a
   Fastify request. TODO(verify): the `worker-src` omission is also deliberate;
   re-read the CSP section before touching headers.
8. **Audit log is append-only** via SQLite triggers *and* a keyed hash chain.
   Do not add an update or delete path.
9. **Sessions**: opaque tokens, SHA-256 hashed at rest, `SameSite=Strict`,
   strict `Origin`/`Host` validation against a *configured* public origin,
   session-bound double-submit CSRF token.
10. **Secrets at rest**: AES-256-GCM with HKDF-derived subkeys.
11. **Boot-time self-checks must keep refusing to start** on critical
    misconfiguration. Do not downgrade one to a warning.

## Dependencies — pinned on purpose

Ranges are in `package.json`; `CLAUDE.md` records what is verified installed.
Do not bump these without reading the reason first.

- `@fastify/static` **must stay on the v10 line** (v10 is the Fastify 5 line;
  v7 pulls `fastify-plugin@^4` with a Fastify 4 peer range and fails the plugin
  version check at boot, and carries two unfixed high-severity advisories).
- `undici` floor **must stay `^7.29.1` in the range itself**, not just the
  lockfile — `7.0.0`–`7.28.0` carry an advisory set including
  GHSA-g9mf-h72j-4rw9 on the `fetch` path this panel uses.
- `otplib` is v13 (ESM-native, `@noble/hashes` + `@scure/base`), chosen for
  `verifySync()` returning the matched `timeStep` and `afterTimeStep` as a
  replay lower bound. TOTP parameters are pinned in
  `src/server/services/totp.service.ts` and asserted against the RFC 6238
  Appendix B vectors in `tests/unit/totp.test.ts`. Do not touch either.
- `argon2` is native and CJS-only; import it by name.
- No Supertest. The suite uses `app.inject()`, and real `curl` against a real
  socket where the point is wire behaviour.

## Migrations

- Numbers are taken by the commit that **lands**, not by the plan. Check the
  highest existing number in `src/server/migrations/` before naming a new file.
- `005_lockout.sql` is left as written; `007_auth.sql` drops the table. There is
  no lockout. Do not resurrect it.
- Tables: `users`, `sessions`, `audit_log`, `audit_chain`, `secrets`,
  `auth_failures`, `recovery_codes`, `notification_queue`, `notification_state`,
  `schema_migrations`. `sqlite_sequence` also appears; it is SQLite's own
  AUTOINCREMENT bookkeeping table, not schema drift.
- Never edit a migration that has shipped. Add a new one.

## Naming

`kebab-case` for configs and scripts, `PascalCase` for React components,
`camelCase` for TS/JS, `PANEL_*` for env vars.
