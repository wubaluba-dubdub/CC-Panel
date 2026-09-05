#!/usr/bin/env bash
#
# Checks a *built* image, not the files that went into it.
#
# Everything here could in principle be read off .dockerignore and the Dockerfile, and
# that is exactly why it is not: a .dockerignore pattern that stops matching is silent,
# a COPY that widens is silent, and a line-ending change that breaks the entrypoint
# names a missing file rather than a formatting problem. The only trustworthy answer
# comes from the image itself.
#
#   usage: scripts/verify-image.sh [image-tag]     (default cc-panel:local)
#
# Exits non-zero on the first failure, with the finding on stderr.

set -uo pipefail

IMAGE="${1:-cc-panel:local}"
FAILURES=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1" >&2
  FAILURES=$((FAILURES + 1))
}

# One shell inside the image. Every check below runs against that filesystem rather
# than against the build context.
in_image() {
  docker run --rm --entrypoint sh "$IMAGE" -c "$1"
}

printf 'Verifying image %s\n\n' "$IMAGE"

docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "FATAL: no such image: $IMAGE (build it with: docker build -t $IMAGE .)" >&2
  exit 2
}

# ── Nothing secret came along for the ride ────────────────────────────────────
#
# `find` over the whole filesystem, not a spot check of /app: a stray COPY, or a
# .dockerignore pattern that quietly stopped matching, can land these anywhere.
printf 'Secrets and local state\n'

leaked_env="$(in_image "find / -xdev -name '.env' -o -xdev -name '.env.*' ! -name '.env.example' 2>/dev/null | head -20")"
if [ -z "$leaked_env" ]; then
  pass "no .env anywhere in the image"
else
  fail "a .env file is in the image: $leaked_env"
fi

leaked_localdata="$(in_image "find / -xdev \( -name '.localdata' -o -name '.localdate' \) 2>/dev/null | head -20")"
if [ -z "$leaked_localdata" ]; then
  pass "no .localdata / .localdate path in the image"
else
  fail "a local data directory is in the image: $leaked_localdata"
fi

leaked_db="$(in_image "find / -xdev -name 'panel.db*' 2>/dev/null | head -20")"
if [ -z "$leaked_db" ]; then
  pass "no panel.db baked into the image"
else
  fail "a database file is in the image: $leaked_db"
fi

# The git history is the largest and worst of these: it carries every earlier version
# of every file, so a secret committed once and removed later is still in there.
leaked_git="$(in_image "find /app -maxdepth 2 -name '.git' 2>/dev/null | head -5")"
if [ -z "$leaked_git" ]; then
  pass "no .git directory in /app"
else
  fail ".git is in the image: $leaked_git"
fi

leaked_tests="$(in_image "find /app -maxdepth 2 -name 'tests' -o -maxdepth 2 -name '*.test.js' 2>/dev/null | head -5")"
if [ -z "$leaked_tests" ]; then
  pass "no test suite in the image"
else
  fail "test code is in the image: $leaked_tests"
fi

# ── The entrypoint is executable, and is LF ───────────────────────────────────
#
# A CRLF entrypoint dies as `exec /entrypoint.sh: no such file or directory`, which
# names the file it just found and reads like a missing-file problem. .gitattributes
# pins the endings; this is the check that the pin held all the way into the image.
printf '\nEntrypoint\n'

cr_count="$(in_image "tr -cd '\\r' < /entrypoint.sh | wc -c")"
if [ "$cr_count" = "0" ]; then
  pass "/entrypoint.sh contains no CR bytes"
else
  fail "/entrypoint.sh contains $cr_count CR byte(s) — it will fail with 'no such file or directory'"
fi

if in_image "test -x /entrypoint.sh"; then
  pass "/entrypoint.sh is executable"
else
  fail "/entrypoint.sh is not executable"
fi

shebang="$(in_image "head -c 9 /entrypoint.sh")"
if [ "$shebang" = "#!/bin/sh" ]; then
  pass "/entrypoint.sh starts with #!/bin/sh"
else
  fail "/entrypoint.sh has an unexpected shebang: $shebang"
fi

# ── What the container needs to do its job ────────────────────────────────────
printf '\nRuntime contents\n'

if in_image "command -v setpriv >/dev/null"; then
  pass "setpriv is present (the privilege drop depends on it)"
else
  fail "setpriv is missing — the entrypoint cannot drop privileges"
fi

if in_image "test -f /etc/ssl/certs/ca-certificates.crt"; then
  pass "a CA bundle is present (M1.7's outbound TLS needs one)"
else
  fail "no CA bundle — an outbound https request will fail unhelpfully"
fi

if in_image "getent passwd 10001 >/dev/null"; then
  pass "uid 10001 exists in /etc/passwd"
else
  fail "uid 10001 has no passwd entry"
fi

if in_image "test -f /app/dist/server/index.js"; then
  pass "the server entry point is at the path CMD names"
else
  fail "/app/dist/server/index.js is missing"
fi

# ── The client bundle, new in M2.1 ────────────────────────────────────────────
#
# The failure this catches is the worst kind this milestone can produce: an image that
# builds cleanly, starts cleanly, answers /healthz with 200, and serves the operator a
# page saying the interface was never built. Nothing in the server's own tests can see
# it, because they run against a fixture client directory on purpose.
if in_image "test -f /app/dist/client/index.html"; then
  pass "the client shell is at the path resolveClientDir() looks in"
else
  fail "/app/dist/client/index.html is missing — vite build did not run, or dist/client was not copied"
fi

# The sentinel must still be *in the file on disk*. Its absence means either that the
# substitution was baked in at build time — a per-installation secret in a layer anyone
# with the image can read — or that the file was produced by something other than this
# build, in which case its asset URLs are wrong for every prefix.
if in_image "grep -q __PANEL_BASE__ /app/dist/client/index.html"; then
  pass "the base-path sentinel is still in the shell on disk (substituted per boot, never baked)"
else
  fail "dist/client/index.html has no sentinel — the prefix may have been baked into the image"
fi

if in_image "test -d /app/dist/client/assets && test -n \"\$(ls -A /app/dist/client/assets)\""; then
  pass "the assets directory is non-empty"
else
  fail "/app/dist/client/assets is missing or empty — the page will load and render nothing"
fi

# Exactly one JS and one CSS asset are expected today (one entry, no code splitting), but
# the assertion is "at least one of each": pinning the count would fail the day a font or
# an image is added, which is not a defect.
for kind in js css; do
  if in_image "ls /app/dist/client/assets/*.$kind >/dev/null 2>&1"; then
    pass "at least one .$kind asset was emitted"
  else
    fail "no .$kind asset in /app/dist/client/assets"
  fi
done

# The OFL requires the licence to travel with the font software. `copy-assets` puts it
# there, after `vite build`, because emptyOutDir would otherwise delete it.
if in_image "test -f /app/dist/client/OFL-Vazirmatn.txt && test -f /app/dist/client/OFL-JetBrainsMono.txt"; then
  pass "the font licences shipped beside the fonts"
else
  fail "a font licence is missing from dist/client — the OFL requires it to be distributed"
fi

# No source map: it is a second copy of the client source in an image that also holds
# PANEL_MASTER_KEY, and nothing debugs this in production.
if in_image "ls /app/dist/client/assets/*.map >/dev/null 2>&1"; then
  fail "a source map shipped in the image"
else
  pass "no source map in the client output"
fi

if in_image "test -f /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node"; then
  pass "the better-sqlite3 native binary was carried forward by the prune"
else
  fail "better-sqlite3's compiled binary is not in the runtime stage"
fi

# The compiler must not be. It is the largest thing the builder installs and a
# toolchain inside a container that will later execute agent processes is a liability.
if in_image "command -v g++ >/dev/null 2>&1 || command -v cc >/dev/null 2>&1"; then
  fail "a C/C++ compiler is present in the runtime stage"
else
  pass "no compiler in the runtime stage"
fi

# Phase 3 and Phase 5 tools are deliberately absent. If one of these starts passing it
# means someone added it early — which is a decision, and should be a visible one.
printf '\nDeliberately absent until Phase 3 / Phase 5\n'
for tool in git tmux rg jq claude; do
  if in_image "command -v $tool >/dev/null 2>&1"; then
    fail "$tool is installed, but no phase before Phase 3 needs it"
  else
    pass "$tool is not installed"
  fi
done

# ── Declared configuration ────────────────────────────────────────────────────
printf '\nImage configuration\n'

config="$(docker image inspect "$IMAGE" --format '{{json .Config}}')"
for expected in '"NODE_ENV=production"' '"PORT=8080"' '"PANEL_DATA_DIR=/data"' \
  '"PANEL_IN_CONTAINER=1"' '"HOME=/data/home"'; do
  if printf '%s' "$config" | grep -q -- "$expected"; then
    pass "ENV ${expected//\"/}"
  else
    fail "ENV ${expected//\"/} is not set on the image"
  fi
done

if printf '%s' "$config" | grep -q '"/entrypoint.sh"'; then
  pass "ENTRYPOINT is /entrypoint.sh"
else
  fail "ENTRYPOINT is not /entrypoint.sh — the privilege drop would be skipped"
fi

# No USER directive, on purpose: the container has to start as root to prepare a
# volume that does not exist until it starts. If this ever becomes `10001` the
# entrypoint's chown stops working and the first boot on a fresh volume fails.
user="$(docker image inspect "$IMAGE" --format '{{.Config.User}}')"
if [ -z "$user" ]; then
  pass "no USER directive (the entrypoint drops instead)"
else
  fail "image declares USER=$user; the entrypoint must own the drop"
fi

if printf '%s' "$config" | grep -q 'healthz'; then
  pass "a HEALTHCHECK on /healthz is declared"
else
  fail "no HEALTHCHECK on /healthz"
fi

printf '\n'
if [ "$FAILURES" -eq 0 ]; then
  printf 'All image checks passed.\n'
  exit 0
fi
printf '%d image check(s) failed.\n' "$FAILURES" >&2
exit 1
