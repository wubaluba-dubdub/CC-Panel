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
- All routes (API, SPA, assets) are mounted under `/${basePath}`.
- `GET /healthz` is the only route outside the prefix, returning `{"ok":true}`.
- Base path is generated on first boot if `PANEL_BASE_PATH` is not set, persisted to `/data/config/instance.json`, and logged once at startup.
- The base path is injected into the SPA via `<script>window.__BASE__="/xxx"</script>` and passed to React Router as `basename`.

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
- Master key from `PANEL_MASTER_KEY` (32 bytes base64) is used via HKDF-SHA256 with distinct `info` labels to derive subkeys.
- AES-256-GCM with 96-bit nonce per write, AAD = `<table>:<rowId>:<column>`.
- `SecretString` wrapper redacts itself in `toString`, `toJSON`, and `util.inspect`.
- Logger redacts common credential patterns as a second line of defense.

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
connect-src 'self' wss://<self>;
frame-ancestors 'none';
base-uri 'none';
form-action 'self'
```
Note: `wss://<self>` is dynamically set to the WebSocket origin of the same host.

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

## Current State (End of Phase 1)
- Security foundation complete (M1).
- Application shell and design system complete (M2).
- No terminal or Claude Code integration yet (reserved for later phases).
- Clean seams left for future work: project directories, settings.json editor, etc.

## Next Steps (Phase 2)
- Implement project creation and management.
- Spawn isolated Claude Code sessions per project.
- Provide a `settings.json` editor for each project.
- Integrate Railway deploy hooks (if desired).

---
*This document will be updated as the project progresses.*