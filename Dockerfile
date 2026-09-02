# ── Builder ───────────────────────────────────────────────────────────────────
#
# node:22-bookworm-slim in BOTH stages, and that is load-bearing rather than tidy.
# better-sqlite3 is a native module compiled here against this image's glibc, libstdc++
# and Node ABI. A runtime stage on a different base — alpine, a different Debian
# release, a different Node major — loads that binary and fails at `require` time with
# an ELF or GLIBC error, at container start, on a deployment that built cleanly.
FROM node:22-bookworm-slim AS builder

# The toolchain better-sqlite3's node-gyp build needs. Present only in this stage;
# nothing below carries a compiler.
# `Acquire::Retries` is not decoration: this build has already failed once on a single
# .deb dropping mid-download, and an image build that fails on a transient network
# error is a failed deployment on Railway too.
RUN apt-get update && \
    apt-get install -y --no-install-recommends -o Acquire::Retries=5 python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Build the native modules against the headers that ship *in this image*, rather than
# letting node-gyp fetch `node-v<version>-headers.tar.gz` from nodejs.org.
#
# Two reasons, and the first one is not the interesting one. It removes a network
# dependency from the build: this is the second thing that failed here with a TLS
# reset, and a build that reaches out to a third host to compile a dependency it has
# already downloaded is a build that fails for reasons unrelated to the change being
# deployed. The better reason is correctness — /usr/local/include/node belongs to the
# exact Node binary that will load the compiled .node file, so the ABI cannot drift
# between what it was compiled against and what runs it.
ENV npm_config_nodedir=/usr/local

# Dependencies before source, so a source-only change reuses the npm layer — which is
# the expensive one, because it compiles better-sqlite3 and argon2.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# The build's second half. `tsc` emits only what it compiles, so the .sql migrations
# have to be copied into dist by hand — see scripts/copy-assets.mjs for the boot
# failure that taught us this.
COPY scripts ./scripts

# Server only. `vite build` was in this script for a milestone before any client
# existed and failed with "Could not resolve entry module"; there is still no client
# to bundle, and tests/integration/build.test.ts is what stops it coming back early.
RUN npm run build

# Drop dev dependencies from the tree that gets copied forward. `npm prune` keeps the
# already-compiled native binaries rather than reinstalling and recompiling them.
RUN npm prune --omit=dev

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# Exactly what the panel needs *today*, and nothing on account of what it will need
# later. Deliberately absent, with the phase that adds each one:
#
#   Phase 3 (terminal + agent processes): git, tmux, and the Claude Code CLI itself.
#     git because a project is a checkout and the second concurrent agent in one
#     project gets a worktree; tmux because a terminal session has to survive the
#     WebSocket dropping; the CLI because that is the thing being run.
#   Phase 5 (agent ergonomics): ripgrep and jq, which Claude Code shells out to often
#     enough that their absence is felt, but which are useless before there is an
#     agent to use them.
#
# They are not installed now because this image is about to be iterated on and every
# one of them is a layer to rebuild, a CVE feed to track, and a binary reachable from
# a process the panel spawns. `ca-certificates` is here because M1.7's Telegram
# transport will make an outbound TLS request and a container with no CA bundle fails
# that with an unhelpful error; `util-linux` supplies `setpriv`, which is how
# entrypoint.sh drops privileges without adding gosu.
RUN apt-get update && \
    apt-get install -y --no-install-recommends -o Acquire::Retries=5 ca-certificates util-linux && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh

# The uid the server runs as. Created here so the name exists in /etc/passwd — the
# ownership of /data is fixed at *runtime* by the entrypoint, because Railway's volume
# mount replaces whatever this build wrote there.
RUN groupadd --system --gid 10001 panel && \
    useradd --system --uid 10001 --gid 10001 --home-dir /data/home --shell /usr/sbin/nologin panel

# HOME must be on the volume: it is where anything the panel or a future agent writes
# to a dotfile ends up, and the container filesystem is ephemeral.
# PANEL_IN_CONTAINER is read by utils/listen-host.ts: a fact the image asserts about
# itself, so the server binds 0.0.0.0 here and 127.0.0.1 on a developer's machine
# without either having to be guessed at.
ENV HOME=/data/home \
    NODE_ENV=production \
    PANEL_DATA_DIR=/data \
    PORT=8080 \
    PANEL_IN_CONTAINER=1

EXPOSE 8080

# For local `docker run`, where nothing else is watching. Railway uses its own
# configured healthcheck (railway.json / the service settings) and ignores this one,
# so this exists so that `docker ps` says something true — see docs/DEPLOY.md.
#
# Uses PORT rather than a literal so overriding the port does not silently disable the
# check. `--start-period` covers migrations and the argon2 dummy-hash computation.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(d=>{if(!d.ok)process.exit(1)}).catch(()=>process.exit(1))"

# No USER directive. The container starts as root on purpose and drops to 10001 in the
# entrypoint, because the volume it has to prepare does not exist until it starts. The
# server refuses to serve if it ever finds itself running as root — see
# src/server/utils/privileges.ts — so "starts as root" cannot decay into "runs as root".
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
