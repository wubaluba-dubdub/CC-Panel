# Claude Code Control Panel — Phase 1 Plan

## File Tree (target state after Phase 1)

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
│   │   │   └── 005_lockout.sql
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
│   │   ├── lockout.test.ts
│   │   ├── totp.test.ts
│   │   └── secret-string.test.ts
│   └── integration/
│       ├── auth.test.ts
│       ├── sessions.test.ts
│       ├── csrf-origin.test.ts
│       ├── base-path.test.ts
│       ├── audit.test.ts
│       ├── rate-limit.test.ts
│       └── secret-leak.test.ts   # sentinel secret grep test
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
- `otplib`                    # RFC 6238 TOTP
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
1. Scaffold project: package.json, tsconfig, vite, vitest, eslint configs.
2. `src/server/env.ts` + boot-time self-checks.
3. `src/server/crypto.ts`: HKDF subkeys, AES-256-GCM encrypt/decrypt with AAD,
   `SecretString` class, argon2id helpers with dummy-hash constant.
4. `src/server/db.ts` + all five migrations.
5. Services layer: user, session, totp, lockout, audit, secrets, instance.
6. Fastify plugins: security-headers, csrf, rate-limit, auth, base-path,
   logger-redaction.
7. Routes: healthz, auth (login/setup/totp), sessions, security, audit, settings,
   spa catch-all.
8. Integration tests covering every acceptance criterion in the security section.
9. **Commit:** `feat(m1): security foundation`

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

## Phase 1 Exit Checklist
- [ ] Docker build verified, container boots as uid 10001 with an empty volume

</content>