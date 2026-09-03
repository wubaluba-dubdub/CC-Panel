#!/usr/bin/env bash
#
# The eleven Phase 1 acceptance criteria, run against a RUNNING CONTAINER.
#
#   usage: scripts/acceptance.sh <dev-container> <dev-port> <prod-container> <prod-port> <prod-domain>
#   e.g.   scripts/acceptance.sh ccp-acc 18090 ccp-acc-prod 18091 panel.example.com
#
# ── Where these eleven came from, stated plainly ─────────────────────────────
#
# The original project prompt referred to "11 acceptance criteria" in its security
# section. **That prompt is not in this repository and never was** — PLAN.md has flagged
# the gap since it was written, and `git log -S acceptance` finds no other copy. So the
# eleven below are RECONSTRUCTED from the Security Model section of CLAUDE.md, which is
# the surviving statement of the same requirements and enumerates exactly eleven: the
# single-user rule plus the ten defence-in-depth bullets. They are now recorded in
# PLAN.md's Phase 1 Exit Checklist so this cannot be lost again. If the operator's
# original list differs, this file is the thing to correct.
#
# Every check runs end to end against the container over its published port. Nothing here
# passes on the strength of a unit test; where a criterion can only be shown from inside
# the container (a table's columns, a stored hash) it uses `docker exec` against the same
# running process's volume, and says so.

set -uo pipefail

DEV_NAME="${1:?usage: acceptance.sh <dev-container> <dev-port> <prod-container> <prod-port> <prod-domain>}"
DEV_PORT="${2:?missing dev port}"
PROD_NAME="${3:?missing prod container}"
PROD_PORT="${4:?missing prod port}"
PROD_DOMAIN="${5:?missing prod domain}"

DEV="http://127.0.0.1:${DEV_PORT}"
PROD="http://127.0.0.1:${PROD_PORT}"
PASSWORD='correct-horse-battery-staple'

PASSES=0
FAILS=0
JAR=""

cleanup() { [ -n "$JAR" ] && rm -f "$JAR"; }
trap cleanup EXIT

criterion() { printf '\n\n\033[1m═══ %s ═══\033[0m\n' "$1"; }
run() {
  printf '\n$ %s\n' "$1"
  eval "$1" 2>&1 | sed 's/^/    /'
}
# Prints a command without running it, for the cases where the real invocation needs a
# secret or a live token that must not appear in the transcript. `run` evaluates what it
# prints, which is right for most checks and misleading for those.
show() { printf '\n$ %s\n' "$1"; }
note() { printf '  · %s\n' "$1"; }
ok() {
  printf '  \033[32mPASS\033[0m  %s\n' "$1"
  PASSES=$((PASSES + 1))
}
no() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1" >&2
  FAILS=$((FAILS + 1))
}
check() { if [ "$1" = "$2" ]; then ok "$3 ($2)"; else no "$3: expected $1, got $2"; fi; }

# `--noproxy '*'`: this machine has http_proxy set, and without it a request to
# 127.0.0.1 goes through the proxy and comes back as the proxy's error page.
CURL=(curl -sS --noproxy '*' --max-time 30)

status() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$@"; }
body() { "${CURL[@]}" "$@"; }
headers() { "${CURL[@]}" -D - -o /dev/null "$@"; }

dev_base() {
  docker exec "$DEV_NAME" node -e \
    "console.log(JSON.parse(require('fs').readFileSync('/data/config/instance.json','utf8')).basePath)"
}
prod_base() {
  docker exec "$PROD_NAME" node -e \
    "console.log(JSON.parse(require('fs').readFileSync('/data/config/instance.json','utf8')).basePath)"
}

# One read-only query against the live volume. Used where a criterion is about what is
# stored, not about what is served.
sql() {
  docker exec "$1" node -e "
    const D = require('/app/node_modules/better-sqlite3');
    const db = new D('/data/panel.db', { readonly: true });
    const rows = db.prepare(process.argv[1]).all();
    console.log(JSON.stringify(rows));
  " "$2"
}

BASE="$(dev_base)"
PBASE="$(prod_base)"
API="${DEV}/${BASE}/api"
PAPI="${PROD}/${PBASE}/api"

csrf_from_jar() {
  awk -F'\t' '{sub(/^#HttpOnly_/,"",$1)} NF>=7 && ($6=="panel_csrf" || $6=="__Secure-panel_csrf") {print $7}' \
    "$JAR" | tail -1
}
cookie_from_jar() {
  awk -F'\t' -v want="$1" '{sub(/^#HttpOnly_/,"",$1)} NF>=7 && $6==want {print $7}' "$JAR" | tail -1
}

totp_code() {
  node --input-type=module -e "
    import { generateSync } from 'otplib';
    process.stdout.write(generateSync({ secret: process.argv[1], algorithm: 'sha1', digits: 6, period: 30 }));
  " "$1"
}

printf 'Acceptance criteria against running containers\n'
printf '  development profile: %s (container %s)\n' "$DEV" "$DEV_NAME"
printf '  production profile:  %s as %s (container %s)\n' "$PROD" "$PROD_DOMAIN" "$PROD_NAME"
printf '  base paths: withheld (they are secrets); lengths %s and %s\n' "${#BASE}" "${#PBASE}"

# ── Log in once on the dev container; several criteria need a full session ────
JAR="$(mktemp -t ccp-acc.XXXXXX)"
LOGIN_JSON="{\"username\":\"admin\",\"password\":\"${PASSWORD}\"}"

enrol_and_login() {
  rm -f "$JAR"
  "${CURL[@]}" -c "$JAR" -b "$JAR" -X POST "$API/auth/login" \
    -H 'content-type: application/json' -d "$LOGIN_JSON" >/dev/null
  local csrf secret
  csrf="$(csrf_from_jar)"

  # Already enrolled? Then this is the second stage, not enrolment.
  if [ -f /tmp/ccp-acc-secret ]; then
    secret="$(cat /tmp/ccp-acc-secret)"
    sleep 31
    "${CURL[@]}" -c "$JAR" -b "$JAR" -X POST "$API/auth/login/totp" \
      -H "x-csrf-token: $csrf" -H 'content-type: application/json' \
      -d "{\"code\":\"$(totp_code "$secret")\"}" >/dev/null
    return
  fi

  secret="$(
    "${CURL[@]}" -c "$JAR" -b "$JAR" -X POST "$API/auth/totp/enroll" -H "x-csrf-token: $csrf" |
      node -e "let r='';process.stdin.on('data',c=>r+=c).on('end',()=>process.stdout.write(JSON.parse(r).secret))"
  )"
  printf '%s' "$secret" >/tmp/ccp-acc-secret
  "${CURL[@]}" -c "$JAR" -b "$JAR" -X POST "$API/auth/totp/enroll/verify" \
    -H "x-csrf-token: $csrf" -H 'content-type: application/json' \
    -d "{\"code\":\"$(totp_code "$secret")\"}" >/dev/null
}

step_up() {
  local csrf
  csrf="$(csrf_from_jar)"
  sleep 31
  "${CURL[@]}" -c "$JAR" -b "$JAR" -X POST "$API/auth/step-up" \
    -H "x-csrf-token: $csrf" -H 'content-type: application/json' \
    -d "{\"password\":\"${PASSWORD}\",\"code\":\"$(totp_code "$(cat /tmp/ccp-acc-secret)")\"}"
}

rm -f /tmp/ccp-acc-secret
enrol_and_login
note "logged in with a full session on the development container"


# ═════════════════════════════════════════════════════════════════════════════
criterion 'C1 — exactly one user, seeded from the environment on first boot, never re-seeded'

run "docker exec $DEV_NAME node -e \"const D=require('/app/node_modules/better-sqlite3');const db=new D('/data/panel.db',{readonly:true});const u=db.prepare('SELECT id,username,totp_enabled FROM users').all();console.log('users:',JSON.stringify(u))\""
USERS="$(sql "$DEV_NAME" 'SELECT COUNT(*) AS c FROM users' | node -e "let r='';process.stdin.on('data',c=>r+=c).on('end',()=>process.stdout.write(String(JSON.parse(r)[0].c)))")"
check 1 "$USERS" 'exactly one user row'

HASH_BEFORE="$(docker exec "$DEV_NAME" node -e "
  const D=require('/app/node_modules/better-sqlite3');const c=require('crypto');
  const db=new D('/data/panel.db',{readonly:true});
  const u=db.prepare('SELECT password_hash FROM users WHERE id=1').get();
  console.log(c.createHash('sha256').update(u.password_hash).digest('hex').slice(0,16));
")"
note "stored hash fingerprint before restart: $HASH_BEFORE"

run "docker restart $DEV_NAME >/dev/null && sleep 8 && docker logs --tail 40 $DEV_NAME 2>&1 | grep -i 'PANEL_ADMIN_PASSWORD' | head -1"
HASH_AFTER="$(docker exec "$DEV_NAME" node -e "
  const D=require('/app/node_modules/better-sqlite3');const c=require('crypto');
  const db=new D('/data/panel.db',{readonly:true});
  const u=db.prepare('SELECT password_hash FROM users WHERE id=1').get();
  console.log(c.createHash('sha256').update(u.password_hash).digest('hex').slice(0,16));
")"
check "$HASH_BEFORE" "$HASH_AFTER" 'the stored hash was not overwritten on the second boot'
check 1 "$(sql "$DEV_NAME" 'SELECT COUNT(*) AS c FROM users' | node -e "let r='';process.stdin.on('data',c=>r+=c).on('end',()=>process.stdout.write(String(JSON.parse(r)[0].c)))")" 'still exactly one user'
if docker logs "$DEV_NAME" 2>&1 | grep -q 'PANEL_ADMIN_PASSWORD is still set'; then
  ok 'the second boot warned that the password variable is still set and is ignored'
else
  no 'no warning about the leftover PANEL_ADMIN_PASSWORD'
fi

# ═════════════════════════════════════════════════════════════════════════════
criterion 'C2 — the secret base path gates everything, /healthz excepted, and never reaches a log'

run "curl -sS --noproxy '*' -o /dev/null -w '%{http_code}\n' $DEV/healthz"
check 200 "$(status "$DEV/healthz")" '/healthz answers outside the prefix'

run "curl -sS --noproxy '*' -w '\n' $DEV/definitely-not-the-base-path/"
check 404 "$(status "$DEV/definitely-not-the-base-path/")" 'a wrong prefix is a 404'
check '{"error":"Not Found"}' "$(body "$DEV/definitely-not-the-base-path/")" 'the 404 body is generic'
check 404 "$(status "$DEV/")" 'the bare root is a 404 too'
check 200 "$(status "$DEV/${BASE}/")" 'the real prefix serves the shell'
check 401 "$(status "$API/auth/me" -H 'x-csrf-token: none')" 'the API lives under the prefix'

run "curl -sS --noproxy '*' -D - -o /dev/null $DEV/${BASE}/ | grep -i referrer-policy"
check 'no-referrer' "$(headers "$DEV/${BASE}/" | grep -i '^referrer-policy:' | tr -d '\r' | awk '{print $2}')" 'Referrer-Policy keeps the prefix out of outbound requests'

# The whole point of the elision: Railway retains stdout, so a prefix in a log line is a
# prefix in long-lived storage that the dashboard can read back.
#
# The first-boot banner is the one deliberate exception — the operator has no other way to
# learn the value — so the assertion is about the *structured* log lines, which is every
# line pino writes and therefore everything that will still be there tomorrow.
LOGLINES="$(docker logs "$DEV_NAME" 2>&1 | grep '^{' || true)"
LEAKS="$(printf '%s' "$LOGLINES" | grep -c -- "$BASE" || true)"
BANNER="$(docker logs "$DEV_NAME" 2>&1 | grep -v '^{' | grep -c -- "$BASE" || true)"
ELIDED="$(printf '%s' "$LOGLINES" | grep -c '<base>' || true)"
run "docker logs $DEV_NAME 2>&1 | grep '^{' | grep -c '<base>'   # elided occurrences in structured lines"
check 0 "$LEAKS" 'the base path appears in no structured log line'
if [ "$ELIDED" -gt 0 ]; then ok "it is logged as <base> instead ($ELIDED lines)"; else no 'nothing was elided, so the check proves nothing'; fi
if [ "$BANNER" -gt 0 ]; then
  ok "the first-boot banner is the only carrier ($BANNER lines), which is the documented exception"
else
  note 'no banner in this log — the container has been restarted since the base path was generated'
fi


# ═════════════════════════════════════════════════════════════════════════════
criterion 'C3 — argon2id password hashing plus mandatory TOTP; a password alone is never enough'

run "docker exec $DEV_NAME node -e \"const D=require('/app/node_modules/better-sqlite3');const db=new D('/data/panel.db',{readonly:true});console.log(db.prepare('SELECT substr(password_hash,1,32) AS h, totp_enabled FROM users').get())\""
ALGO="$(docker exec "$DEV_NAME" node -e "
  const D=require('/app/node_modules/better-sqlite3');
  const db=new D('/data/panel.db',{readonly:true});
  console.log(db.prepare('SELECT password_hash AS h FROM users').get().h.split('\$')[1]);
")"
check 'argon2id' "$ALGO" 'the stored password hash is argon2id'

rm -f "$JAR"
show "curl -sS --noproxy '*' -c \$JAR -b \$JAR -X POST $API/auth/login -H 'content-type: application/json' -d '{\"username\":\"admin\",\"password\":\"<the password>\"}'"
STAGE1="$(body -c "$JAR" -b "$JAR" -X POST "$API/auth/login" -H 'content-type: application/json' -d "$LOGIN_JSON")"
printf '    %s\n' "$STAGE1"
# `{"stage":"totp"}` — the response says what is still owed, not what has been granted.
case "$STAGE1" in *'"stage":"totp"'*) ok 'the password alone yields only "the second factor is still owed"' ;; *) no "unexpected stage-one body: $STAGE1" ;; esac
# `authLevel` is nested under `session` in the /me response, which is why the smoke test's
# substring check on the whole body passed while a top-level read came back empty.
LEVEL="$(body -c "$JAR" -b "$JAR" "$API/auth/me" | node -e "let r='';process.stdin.on('data',c=>r+=c).on('end',()=>{try{process.stdout.write(JSON.parse(r).session.authLevel)}catch{process.stdout.write('')}})")"
check 'pre' "$LEVEL" 'and the session it issued is at level pre'
check 401 "$(status -c "$JAR" -b "$JAR" "$API/sessions" -H "x-csrf-token: $(csrf_from_jar)")" 'a pre session cannot reach a full-session route'

TOTP_ENABLED="$(sql "$DEV_NAME" 'SELECT totp_enabled AS t FROM users' | node -e "let r='';process.stdin.on('data',c=>r+=c).on('end',()=>process.stdout.write(String(JSON.parse(r)[0].t)))")"
check 1 "$TOTP_ENABLED" 'two-factor is enabled on the one account'
SECRET_VERSION="$(docker exec "$DEV_NAME" node -e "
  const D=require('/app/node_modules/better-sqlite3');
  const db=new D('/data/panel.db',{readonly:true});
  console.log(db.prepare('SELECT substr(totp_secret_encrypted,1,3) AS v FROM users').get().v);
")"
check 'v1.' "$SECRET_VERSION" 'the TOTP secret is stored as a versioned ciphertext, not base32'

CSRF="$(csrf_from_jar)"
sleep 31
show "curl -sS --noproxy '*' -c \$JAR -b \$JAR -X POST $API/auth/login/totp -H 'x-csrf-token: <from the jar>' -d '{\"code\":\"<fresh 6 digits>\"}'"
STAGE2="$(body -c "$JAR" -b "$JAR" -X POST "$API/auth/login/totp" -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/json' -d "{\"code\":\"$(totp_code "$(cat /tmp/ccp-acc-secret)")\"}")"
printf '    %s\n' "$STAGE2"
case "$STAGE2" in *'"stage":"authenticated"'*) ok 'the second factor promotes the session' ;; *) no "unexpected stage-two body: $STAGE2" ;; esac
check 200 "$(status -c "$JAR" -b "$JAR" "$API/sessions" -H "x-csrf-token: $(csrf_from_jar)")" 'the promoted session reaches a full-session route'

# ═════════════════════════════════════════════════════════════════════════════
criterion 'C4 — a progressive response delay, not a lockout, and no per-IP logic anywhere'

# Times a failed password step, and reports the status with it. The delay is padding to a
# *target* measured from the start of the attempt, so argon2's own cost is absorbed rather
# than added — and the status matters because anything other than a 401 means the request
# was rejected before the delay ran and the timing says nothing.
#
# Nothing resets the counter first: the container is fresh, so it is already zero, and a
# second writer on the live database is exactly the kind of interference that would make
# these numbers mean something other than what they claim.
# Prints "<elapsed-ms> <status>". Both on stdout, because the call site is a command
# substitution and therefore a subshell: a variable assigned in here would not survive it.
timed_fail() {
  local ip="${1:-198.51.100.9}" start end code
  start="$(date +%s%N)"
  code="$(status -X POST "$API/auth/login" -H 'content-type: application/json' \
    -H "X-Forwarded-For: $ip" \
    -d '{"username":"admin","password":"definitely-not-the-password"}')"
  end="$(date +%s%N)"
  echo "$(((end - start) / 1000000)) $code"
}

printf '\n$ six consecutive failed logins, each timed, each from a DIFFERENT X-Forwarded-For\n'
DELAYS=()
CODES=()
for i in 1 2 3 4 5 6; do
  read -r ms code <<<"$(timed_fail "203.0.113.$i")"
  DELAYS+=("$ms")
  CODES+=("$code")
  printf '    attempt %d from 203.0.113.%d: %5s ms  HTTP %s\n' "$i" "$i" "$ms" "$code"
done

UNEXPECTED="$(printf '%s\n' "${CODES[@]}" | grep -vc '^401$' || true)"
if [ "$UNEXPECTED" = "0" ]; then
  ok 'every attempt was a 401, so each timing is a timing of the delay and not of a rejection'
else
  no "not every attempt was a 401 (${CODES[*]}) — the timings below are not comparable"
fi

# Failures 1-3 are unpadded; 4 targets 500 ms, 5 targets 1 s, 6 targets 2 s.
if [ "${DELAYS[3]}" -ge 450 ] && [ "${DELAYS[4]}" -ge 950 ] && [ "${DELAYS[5]}" -ge 1900 ]; then
  ok "the delay grows with the counter (${DELAYS[3]}, ${DELAYS[4]}, ${DELAYS[5]} ms) despite a new address each time"
else
  no "the delay did not grow as expected: ${DELAYS[*]}"
fi
if [ "${DELAYS[0]}" -lt 450 ]; then
  ok "the first failures are unpadded (${DELAYS[0]} ms), so the schedule starts at zero"
else
  no "the first attempt was already padded: ${DELAYS[0]} ms"
fi

# The point of "delay, not lockout": after any number of failures the correct password
# still works. A lockout here would be a denial-of-service primitive on a single-user panel.
printf '\n$ the correct password, immediately after six failures\n'
rm -f "$JAR"
CORRECT="$(status -c "$JAR" -b "$JAR" -X POST "$API/auth/login" -H 'content-type: application/json' -d "$LOGIN_JSON")"
check 200 "$CORRECT" 'the correct password still succeeds — there is no lockout'

run "docker exec $DEV_NAME node -e \"const D=require('/app/node_modules/better-sqlite3');const db=new D('/data/panel.db',{readonly:true});console.log('auth_failures columns:', db.prepare('PRAGMA table_info(auth_failures)').all().map(c=>c.name).join(','));console.log('lockouts table exists:', db.prepare(\\\"SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='lockouts'\\\").get().c === 1)\""
COLS="$(docker exec "$DEV_NAME" node -e "
  const D=require('/app/node_modules/better-sqlite3');
  const db=new D('/data/panel.db',{readonly:true});
  console.log(db.prepare('PRAGMA table_info(auth_failures)').all().map(c=>c.name).join(','));
")"
case "$COLS" in
*ip* | *scope*) no "auth_failures still has an address or scope column: $COLS" ;;
*) ok "auth_failures is keyed on nothing ($COLS)" ;;
esac
LOCKOUTS="$(docker exec "$DEV_NAME" node -e "
  const D=require('/app/node_modules/better-sqlite3');
  const db=new D('/data/panel.db',{readonly:true});
  console.log(db.prepare(\"SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='lockouts'\").get().c);
")"
check 0 "$LOCKOUTS" 'migration 005 lockouts table stays dropped'


# ═════════════════════════════════════════════════════════════════════════════
criterion 'C5 — opaque server-side sessions, stored only as a hash, revocable on the next request'

enrol_and_login
COOKIE="$(cookie_from_jar panel_session)"
run "docker exec $DEV_NAME node -e \"const D=require('/app/node_modules/better-sqlite3');const db=new D('/data/panel.db',{readonly:true});console.log(db.prepare('SELECT id, length(token_hash) AS len, substr(token_hash,1,12) AS head, auth_level FROM sessions ORDER BY id DESC LIMIT 3').all())\""

HASHLEN="$(docker exec "$DEV_NAME" node -e "
  const D=require('/app/node_modules/better-sqlite3');
  const db=new D('/data/panel.db',{readonly:true});
  console.log(db.prepare('SELECT length(token_hash) AS l FROM sessions ORDER BY id DESC LIMIT 1').get().l);
")"
check 64 "$HASHLEN" 'the stored value is a 64-character SHA-256 hex digest'

# The cookie the client holds must not be findable anywhere in the database — including
# the WAL and the shared-memory file, which is the trap CLAUDE.md records.
FOUND="$(docker exec "$DEV_NAME" sh -c "cat /data/panel.db /data/panel.db-wal /data/panel.db-shm 2>/dev/null | grep -c '$COOKIE' || true")"
check 0 "$FOUND" 'the plaintext session token appears in none of the three SQLite files'

SESSION_ID="$(body -c "$JAR" -b "$JAR" "$API/sessions" -H "x-csrf-token: $(csrf_from_jar)" |
  node -e "let r='';process.stdin.on('data',c=>r+=c).on('end',()=>{const s=JSON.parse(r).sessions.find(x=>x.current);process.stdout.write(String(s.id))})")"
check 200 "$(status -c "$JAR" -b "$JAR" "$API/auth/me")" 'the session works before revocation'
show "curl -sS --noproxy '*' -b \$JAR -X DELETE $API/sessions/$SESSION_ID -H 'x-csrf-token: <from the jar>' -o /dev/null -w '%{http_code}\n'"
REVOKE="$(status -b "$JAR" -X DELETE "$API/sessions/$SESSION_ID" -H "x-csrf-token: $(csrf_from_jar)")"
check 204 "$REVOKE" 'revoking the current session answers 204'
check 401 "$(status -H "Cookie: panel_session=$COOKIE" "$API/auth/me")" 'the very next request with that cookie is 401'

# ═════════════════════════════════════════════════════════════════════════════
criterion 'C6 — SameSite=Strict, strict Origin/Host validation, and a session-bound CSRF token'

rm -f "$JAR"
run "curl -sS --noproxy '*' -c \$JAR -b \$JAR -D - -o /dev/null -X POST $API/auth/login … | grep -i set-cookie"
SETCOOKIE="$("${CURL[@]}" -c "$JAR" -b "$JAR" -D - -o /dev/null -X POST "$API/auth/login" \
  -H 'content-type: application/json' -d "$LOGIN_JSON" | grep -i '^set-cookie:' | tr -d '\r')"
printf '%s\n' "$SETCOOKIE" | sed 's/^/    /'
case "$SETCOOKIE" in *SameSite=Strict*) ok 'both cookies are SameSite=Strict' ;; *) no 'SameSite=Strict missing' ;; esac
case "$SETCOOKIE" in *panel_session*HttpOnly*) ok 'the session cookie is HttpOnly' ;; *) no 'the session cookie is not HttpOnly' ;; esac
case "$SETCOOKIE" in *"Path=/${BASE}"*) ok 'both cookies are scoped to the base path' ;; *) no 'the cookie path is not the base path' ;; esac

CSRF="$(csrf_from_jar)"
# The three rejections, then the acceptance. `POST /api/auth/logout` is the mutating route
# used for all four because a `pre` session may reach it: `/api/auth/totp/enroll` becomes
# step-up gated the moment two-factor is on, so a 403 there would be ambiguous.
LOGOUT="$API/auth/logout"
show "curl -sS --noproxy '*' -b \$JAR -X POST $LOGOUT -H 'Origin: https://evil.example' -H 'x-csrf-token: <from the jar>'"
check 403 "$(status -b "$JAR" -X POST "$LOGOUT" -H 'Origin: https://evil.example' -H "x-csrf-token: $CSRF")" 'a foreign Origin on a mutating request is a 403'
check '{"error":"Forbidden"}' "$(body -b "$JAR" -X POST "$LOGOUT" -H 'Origin: https://evil.example' -H "x-csrf-token: $CSRF")" 'and the body names no reason'

show "curl -sS --noproxy '*' -b \$JAR -X POST $LOGOUT   # no X-CSRF-Token at all"
check 403 "$(status -b "$JAR" -X POST "$LOGOUT")" 'a mutating request with a session and no CSRF header is a 403'
check 403 "$(status -b "$JAR" -X POST "$LOGOUT" -H 'x-csrf-token: not-the-token')" 'a wrong CSRF token is a 403'
# Last, because it succeeds and therefore ends the session.
ACCEPTED="$(status -b "$JAR" -X POST "$LOGOUT" -H "x-csrf-token: $CSRF" -H "Origin: $DEV")"
if [ "$ACCEPTED" = "200" ] || [ "$ACCEPTED" = "204" ]; then
  ok "the same request with the real Origin and the real token succeeds ($ACCEPTED)"
else
  no "the accepting path did not succeed: $ACCEPTED"
fi

printf '\n$ the production container, where the Host check is exact\n'
check 403 "$(status "$PROD/${PBASE}/" -H 'Host: evil.example')" 'a poisoned Host inside the prefix is a 403'
check 200 "$(status "$PROD/healthz" -H 'Host: evil.example')" '/healthz stays exempt, because a 403 there is a container-kill primitive'
check 200 "$(status "$PROD/${PBASE}/" -H "Host: $PROD_DOMAIN" -H 'X-Forwarded-Proto: https')" 'the configured Host is accepted'
check 403 "$(status -X POST "$PAPI/auth/login" -H "Host: $PROD_DOMAIN" -H 'X-Forwarded-Proto: http' -H 'content-type: application/json' -d "$LOGIN_JSON")" 'a forwarded plaintext hop under an https origin is a 403'


# ═════════════════════════════════════════════════════════════════════════════
criterion 'C7 — the response header set, and HSTS in production only'

run "curl -sS --noproxy '*' -D - -o /dev/null $DEV/${BASE}/ | sed 1d"
DEVH="$(headers "$DEV/${BASE}/" | tr -d '\r')"
for h in 'x-content-type-options: nosniff' 'x-frame-options: DENY' 'referrer-policy: no-referrer' \
  'cross-origin-opener-policy: same-origin' 'cross-origin-resource-policy: same-origin' \
  "content-security-policy: default-src 'none'" 'permissions-policy: accelerometer=()'; do
  if printf '%s' "$DEVH" | grep -qi -- "$h"; then ok "$h"; else no "missing: $h"; fi
done
if printf '%s' "$DEVH" | grep -qi 'strict-transport-security'; then
  no 'HSTS is sent outside production'
else
  ok 'HSTS is absent outside production'
fi
for absent in 'server:' 'x-powered-by:' 'x-xss-protection:'; do
  if printf '%s' "$DEVH" | grep -qi "^$absent"; then no "$absent is present"; else ok "$absent stays absent"; fi
done

run "curl -sS --noproxy '*' -D - -o /dev/null -H 'Host: $PROD_DOMAIN' -H 'X-Forwarded-Proto: https' $PROD/${PBASE}/ | grep -i strict-transport"
PRODH="$(headers "$PROD/${PBASE}/" -H "Host: $PROD_DOMAIN" -H 'X-Forwarded-Proto: https' | tr -d '\r')"
if printf '%s' "$PRODH" | grep -qi 'strict-transport-security: max-age=63072000; includeSubDomains; preload'; then
  ok 'production sends the full HSTS value'
else
  no 'production HSTS is missing or wrong'
fi


# ═════════════════════════════════════════════════════════════════════════════
criterion 'C8 — secrets at rest: AES-256-GCM under an HKDF subkey, versioned, never in plaintext'

enrol_and_login
printf '\n$ step up, then PUT a sentinel secret through the API\n'
step_up | sed 's/^/    /'
SENTINEL="sk-ant-api03-ACCEPTANCE-SENTINEL-$(date +%s)"
PUTCODE="$(status -b "$JAR" -X PUT "$API/secrets" -H "x-csrf-token: $(csrf_from_jar)" \
  -H 'content-type: application/json' \
  -d "{\"scope\":\"acceptance\",\"name\":\"probe\",\"value\":\"${SENTINEL}\"}")"
check 204 "$PUTCODE" 'writing a secret with a step-up answers 204'

run "docker exec $DEV_NAME node -e \"const D=require('/app/node_modules/better-sqlite3');const db=new D('/data/panel.db',{readonly:true});const r=db.prepare(\\\"SELECT scope,name,substr(payload,1,3) AS version, length(payload) AS len FROM secrets WHERE scope='acceptance'\\\").get();console.log(r)\""
PAYVER="$(docker exec "$DEV_NAME" node -e "
  const D=require('/app/node_modules/better-sqlite3');
  const db=new D('/data/panel.db',{readonly:true});
  console.log(db.prepare(\"SELECT substr(payload,1,3) AS v FROM secrets WHERE scope='acceptance'\").get().v);
")"
check 'v1.' "$PAYVER" 'the stored payload is the versioned envelope'

# All three files, because a freshly written row lives in the WAL.
LEAK="$(docker exec "$DEV_NAME" sh -c "cat /data/panel.db /data/panel.db-wal /data/panel.db-shm 2>/dev/null | grep -c '$SENTINEL' || true")"
check 0 "$LEAK" 'the plaintext appears in none of panel.db, -wal or -shm'
LOGLEAK="$(docker logs "$DEV_NAME" 2>&1 | grep -c -- "$SENTINEL" || true)"
check 0 "$LOGLEAK" 'and in no log line'

printf '\n$ reveal it back through the API, which is the only way out\n'
REVEALED="$(body -b "$JAR" -X POST "$API/secrets/reveal" -H "x-csrf-token: $(csrf_from_jar)" \
  -H 'content-type: application/json' -d '{"scope":"acceptance","name":"probe"}')"
case "$REVEALED" in *"$SENTINEL"*) ok 'the round trip decrypts to the original value' ;; *) no "reveal did not return the value: $REVEALED" ;; esac
AUDITLEAK="$(sql "$DEV_NAME" "SELECT COUNT(*) AS c FROM audit_log WHERE meta_json LIKE '%${SENTINEL}%'" |
  node -e "let r='';process.stdin.on('data',c=>r+=c).on('end',()=>process.stdout.write(String(JSON.parse(r)[0].c)))")"
check 0 "$AUDITLEAK" 'the audit rows for the write and the reveal carry the reference, not the value'

# ═════════════════════════════════════════════════════════════════════════════
criterion 'C10 — rate limiting with no address in it, plus size and receipt-time bounds'

printf '\n$ a 1 MiB body against the login endpoint (bodyLimit is 64 KiB)\n'
BIG="$(mktemp)"
node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({username:'admin',password:'x'.repeat(1024*1024)}))" "$BIG"
BIGCODE="$(status -X POST "$API/auth/login" -H 'content-type: application/json' --data-binary "@$BIG")"
rm -f "$BIG"
check 413 "$BIGCODE" 'an oversized body is rejected before the JSON parser'

printf '\n$ empty the shared anonymous bucket with 70 unauthenticated requests, rotating X-Forwarded-For\n'
LIMITED=0
RETRY_AFTER=""
for i in $(seq 1 70); do
  out="$("${CURL[@]}" -o /dev/null -D - -w '%{http_code}' \
    -H "X-Forwarded-For: 198.51.100.$((i % 250 + 1))" "$DEV/${BASE}/bootstrap.js" 2>/dev/null | tr -d '\r')"
  case "$out" in
  *429*)
    LIMITED=$((LIMITED + 1))
    [ -z "$RETRY_AFTER" ] && RETRY_AFTER="$(printf '%s' "$out" | grep -i '^retry-after:' | awk '{print $2}')"
    ;;
  esac
done
printf '    429 responses: %s, first Retry-After: %s\n' "$LIMITED" "${RETRY_AFTER:-none}"
if [ "$LIMITED" -gt 0 ]; then
  ok "the anonymous bucket throttles despite a different address on every request ($LIMITED × 429)"
else
  no 'no request was throttled, so the bucket is not doing anything'
fi
if [ -n "$RETRY_AFTER" ] && [ "$RETRY_AFTER" -ge 1 ]; then
  ok "Retry-After is a whole number of seconds and never 0 ($RETRY_AFTER)"
else
  no "Retry-After was ${RETRY_AFTER:-absent}"
fi
check 200 "$(status "$DEV/healthz")" '/healthz stays exempt while the bucket is empty'
check 404 "$(status "$DEV/not-the-base-path")" 'the out-of-prefix 404 sink stays exempt too'


# ═════════════════════════════════════════════════════════════════════════════
criterion 'C11 — boot-time self-checks refuse to start on a critical misconfiguration'

IMAGE="$(docker inspect --format '{{.Config.Image}}' "$DEV_NAME")"
refuses() {
  local label="$1"
  shift
  local out
  out="$(docker run --rm "$@" "$IMAGE" 2>&1)"
  local rc=$?
  printf '\n$ docker run --rm %s %s\n' "$*" "$IMAGE"
  printf '%s\n' "$out" | tail -3 | sed 's/^/    /'
  if [ "$rc" -ne 0 ]; then ok "$label (exit $rc)"; else no "$label — the container started"; fi
}

refuses 'no PANEL_MASTER_KEY at all' -e PANEL_ADMIN_USERNAME=admin -e PANEL_ADMIN_PASSWORD="$PASSWORD"
refuses 'a master key that decodes to fewer than 32 bytes' \
  -e PANEL_MASTER_KEY=dG9vLXNob3J0 -e PANEL_ADMIN_USERNAME=admin -e PANEL_ADMIN_PASSWORD="$PASSWORD"
refuses 'production with no public origin' \
  -e PANEL_MASTER_KEY="$(docker exec "$DEV_NAME" printenv PANEL_MASTER_KEY)" \
  -e PANEL_ADMIN_USERNAME=admin -e PANEL_ADMIN_PASSWORD="$PASSWORD"
refuses 'production with an http public origin' \
  -e PANEL_MASTER_KEY="$(docker exec "$DEV_NAME" printenv PANEL_MASTER_KEY)" \
  -e PANEL_PUBLIC_URL=http://panel.example.com \
  -e PANEL_ADMIN_USERNAME=admin -e PANEL_ADMIN_PASSWORD="$PASSWORD"
refuses 'a weak admin password' \
  -e PANEL_MASTER_KEY="$(docker exec "$DEV_NAME" printenv PANEL_MASTER_KEY)" \
  -e PANEL_PUBLIC_URL=https://panel.example.com \
  -e PANEL_ADMIN_USERNAME=admin -e PANEL_ADMIN_PASSWORD=password123456
refuses 'no user in the database and no credentials to make one from' \
  -e PANEL_MASTER_KEY="$(docker exec "$DEV_NAME" printenv PANEL_MASTER_KEY)" \
  -e PANEL_PUBLIC_URL=https://panel.example.com

printf '\n$ the entrypoint bypassed, so the server would run as root\n'
ROOTOUT="$(docker run --rm --entrypoint node \
  -e PANEL_MASTER_KEY="$(docker exec "$DEV_NAME" printenv PANEL_MASTER_KEY)" \
  -e PANEL_PUBLIC_URL=https://panel.example.com \
  -e PANEL_ADMIN_USERNAME=admin -e PANEL_ADMIN_PASSWORD="$PASSWORD" \
  "$IMAGE" dist/server/index.js 2>&1 | tail -2)"
printf '%s\n' "$ROOTOUT" | sed 's/^/    /'
case "$ROOTOUT" in *'refuses to serve'*) ok 'the server refuses to serve as root' ;; *) no 'a root server was not refused' ;; esac


# ═════════════════════════════════════════════════════════════════════════════
# C9 goes LAST, because proving the chain detects tampering means tampering with this
# container's audit log. Everything above needs an intact one.
criterion 'C9 — the audit log is append-only through two independent controls'

enrol_and_login
run "curl -sS --noproxy '*' -b \$JAR $API/audit/verify"
VERIFY="$(body -b "$JAR" "$API/audit/verify")"
printf '    %s\n' "$VERIFY"
case "$VERIFY" in *'"ok":true'*) ok 'the chain verifies before any tampering' ;; *) no "the chain did not verify to begin with: $VERIFY" ;; esac

printf '\n$ this process tries to UPDATE and DELETE an audit row (migration 008 triggers)\n'
TRIG="$(docker exec "$DEV_NAME" node -e "
  const D=require('/app/node_modules/better-sqlite3');
  const db=new D('/data/panel.db');
  for (const sql of ['UPDATE audit_log SET outcome = \'failure\' WHERE id = 1',
                     'DELETE FROM audit_log WHERE id = 1']) {
    try { db.prepare(sql).run(); console.log('ALLOWED:', sql); }
    catch (e) { console.log('REFUSED:', e.message); }
  }
" 2>&1)"
printf '%s\n' "$TRIG" | sed 's/^/    /'
REFUSALS="$(printf '%s' "$TRIG" | grep -c 'REFUSED: .*append-only')"
check 2 "$REFUSALS" 'both UPDATE and DELETE are refused by the triggers'

printf '\n$ the attacker with the file: drop the triggers, then edit a row\n'
TAMPER="$(docker exec "$DEV_NAME" node -e "
  const D=require('/app/node_modules/better-sqlite3');
  const db=new D('/data/panel.db');
  db.exec('DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;');
  const target = db.prepare('SELECT id FROM audit_log ORDER BY id ASC LIMIT 1 OFFSET 2').get().id;
  db.prepare('UPDATE audit_log SET user_agent = ? WHERE id = ?').run('tampered', target);
  console.log('edited row', target, 'with the triggers gone');
" 2>&1)"
printf '%s\n' "$TAMPER" | sed 's/^/    /'
AFTER="$(body -b "$JAR" "$API/audit/verify")"
printf '    %s\n' "$AFTER"
case "$AFTER" in
*'"ok":false'*'"reason":"row_hash_mismatch"'*) ok 'the keyed chain catches the edit the triggers could not stop' ;;
*) no "the chain did not report the tamper: $AFTER" ;;
esac
case "$AFTER" in
*'"hint":null'*) ok 'and gives no wrong-key hint, because the break is partway down the chain' ;;
*) no 'the hint should be null for a mid-chain break' ;;
esac
printf '  · this container'"'"'s audit log is now deliberately broken. It is a throwaway.\n'


# ═════════════════════════════════════════════════════════════════════════════
printf '\n\n\033[1m═══ Result ═══\033[0m\n'
printf '  %d passed, %d failed\n' "$PASSES" "$FAILS"
[ "$FAILS" -eq 0 ] || exit 1

