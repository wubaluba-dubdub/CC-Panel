#!/usr/bin/env bash
#
# End-to-end smoke test against a *running container*, over HTTP, with real curl and a
# real cookie jar.
#
#   usage: scripts/container-smoke.sh <base-url> <base-path> [username] [password]
#   e.g.   scripts/container-smoke.sh http://127.0.0.1:18080 MuR_8kODEMB1CtKdTEUX7Q
#
# Why curl and a jar rather than `fetch` with a header dictionary: the controls this
# exercises are precisely the ones a hand-rolled client would paper over. A real client
# parses `Set-Cookie`, decides whether a cookie is in scope for a path, refuses to send
# a `Secure` cookie over http, and reads a non-HttpOnly cookie back out to echo it in a
# header. `tests/integration/csrf.test.ts` makes the same argument in-process; this is
# the same argument across a container boundary and a published port.
#
# It also has no access to the server's internals. The TOTP secret comes back from the
# enrolment endpoint like any client's would, and the CSRF token is read out of the jar
# — never computed.
#
# Prints each step and exits non-zero on the first failure.

set -uo pipefail

BASE_URL="${1:?usage: container-smoke.sh <base-url> <base-path> [username] [password]}"
BASE_PATH="${2:?missing base path}"
USERNAME="${3:-admin}"
PASSWORD="${4:-correct-horse-battery-staple}"

API="${BASE_URL}/${BASE_PATH}/api"
JAR="$(mktemp -t ccp-jar.XXXXXX)"
trap 'rm -f "$JAR"' EXIT

FAILURES=0
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1" >&2
  FAILURES=$((FAILURES + 1))
}

# --noproxy '*': this machine has http_proxy set, and without it even a request to
# 127.0.0.1 goes through the proxy, which answers with its own error page and no
# cookies. The failure looks like a panel bug and is not one.
CURL=(curl -sS --noproxy '*' --max-time 20 -c "$JAR" -b "$JAR")

LAST_STATUS=""
LAST_BODY=""
LAST_HEADERS=""

# One request. Body and status are separated by a sentinel rather than by parsing, so a
# JSON body containing a newline cannot confuse the split.
request() {
  local method="$1" path="$2" body="${3:-}"
  local args=("${CURL[@]}" -D /dev/stderr -X "$method" -w '\n<<<STATUS>>>%{http_code}')
  if [ -n "$body" ]; then
    args+=(-H 'content-type: application/json' --data-binary "$body")
  fi
  # The double-submit token: read out of the jar, exactly as a browser's script would
  # read the non-HttpOnly cookie. Absent before the first session exists.
  local csrf
  csrf="$(csrf_from_jar)"
  if [ -n "$csrf" ]; then
    args+=(-H "x-csrf-token: ${csrf}")
  fi

  local combined
  combined="$("${args[@]}" "${path}" 2>/tmp/ccp-headers)"
  LAST_HEADERS="$(cat /tmp/ccp-headers)"
  LAST_STATUS="${combined##*<<<STATUS>>>}"
  LAST_BODY="${combined%$'\n'<<<STATUS>>>*}"
}

# The Netscape jar format is tab-separated, and an HttpOnly cookie has `#HttpOnly_`
# prepended to its domain field — which is why a parser that skips lines starting with
# `#` cannot see the session cookie at all.
cookie_from_jar() {
  local name="$1"
  awk -F'\t' -v want="$name" '
    { sub(/^#HttpOnly_/, "", $1) }
    NF >= 7 && $6 == want { print $7 }
  ' "$JAR" | tail -1
}

csrf_from_jar() {
  local value
  value="$(cookie_from_jar panel_csrf)"
  [ -n "$value" ] || value="$(cookie_from_jar __Secure-panel_csrf)"
  printf '%s' "$value"
}

expect_status() {
  if [ "$LAST_STATUS" = "$1" ]; then
    pass "$2 → $LAST_STATUS"
  else
    fail "$2 → expected $1, got $LAST_STATUS; body: $LAST_BODY"
  fi
}

json_field() {
  printf '%s' "$LAST_BODY" | node -e "
    let raw='';
    process.stdin.on('data', (c) => (raw += c)).on('end', () => {
      try { const v = JSON.parse(raw)['$1']; process.stdout.write(v === undefined ? '' : String(v)); }
      catch { process.stdout.write(''); }
    });
  "
}

# A valid code for `secret`, right now, with the parameters the server verifies with
# (src/server/services/totp.service.ts: sha1, 6 digits, 30s).
totp_code() {
  node --input-type=module -e "
    import { generateSync } from 'otplib';
    process.stdout.write(generateSync({
      secret: process.argv[1], algorithm: 'sha1', digits: 6, period: 30,
    }));
  " "$1"
}

printf 'Smoke-testing %s (base path withheld from this line)\n' "$BASE_URL"

step '1. /healthz, outside the base path and outside any session'
request GET "${BASE_URL}/healthz"
expect_status 200 'GET /healthz'
[ "$LAST_BODY" = '{"ok":true}' ] && pass 'body is exactly {"ok":true}' ||
  fail "body is not {\"ok\":true}: $LAST_BODY"

step '2. the base path is a gate'
request GET "${BASE_URL}/definitely-not-the-base-path/"
expect_status 404 'GET a wrong prefix'
request GET "${BASE_URL}/${BASE_PATH}/"
expect_status 200 'GET the real prefix'
case "$LAST_BODY" in
*'bootstrap.js'*) pass 'the shell references bootstrap.js rather than inlining it' ;;
*) fail 'the shell does not reference bootstrap.js' ;;
esac

step '3. stage one — the password'
request POST "${API}/auth/login" "{\"username\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
expect_status 200 'POST /api/auth/login'
SESSION="$(cookie_from_jar panel_session)"
[ -n "$SESSION" ] && pass 'a session cookie was set and accepted by the jar' ||
  fail 'no session cookie in the jar (a Secure/prefix mismatch would look like this)'
[ -n "$(csrf_from_jar)" ] && pass 'a CSRF cookie was set alongside it' ||
  fail 'no CSRF cookie in the jar'

step '4. a pre session cannot reach a full-session route'
request GET "${API}/sessions"
expect_status 401 'GET /api/sessions with a pre session'

step '5. mandatory TOTP enrolment'
request POST "${API}/auth/totp/enroll"
expect_status 200 'POST /api/auth/totp/enroll'
SECRET="$(json_field secret)"
[ -n "$SECRET" ] && pass "enrolment returned a base32 secret (${#SECRET} chars)" ||
  fail 'enrolment returned no secret'

request POST "${API}/auth/totp/enroll/verify" "{\"code\":\"$(totp_code "$SECRET")\"}"
expect_status 200 'POST /api/auth/totp/enroll/verify'
RECOVERY_COUNT="$(printf '%s' "$LAST_BODY" | node -e "
  let raw=''; process.stdin.on('data',c=>raw+=c).on('end',()=>{
    try { process.stdout.write(String((JSON.parse(raw).recoveryCodes||[]).length)); } catch { process.stdout.write('0'); }
  });")"
[ "$RECOVERY_COUNT" = "10" ] && pass 'ten single-use recovery codes returned exactly once' ||
  fail "expected 10 recovery codes, got $RECOVERY_COUNT"

step '6. the promoted session is a full one'
request GET "${API}/sessions"
expect_status 200 'GET /api/sessions with a full session'

step '7. a second, complete two-stage login'
# A fresh jar, so this is a login and not the session from step 5.
rm -f "$JAR"
request POST "${API}/auth/login" "{\"username\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
expect_status 200 'POST /api/auth/login (stage one)'
# The previous code was consumed; replay protection correctly refuses it inside its own
# window, so wait for the next step rather than asserting a failure.
sleep 31
request POST "${API}/auth/login/totp" "{\"code\":\"$(totp_code "$SECRET")\"}"
expect_status 200 'POST /api/auth/login/totp (stage two)'
request GET "${API}/auth/me"
expect_status 200 'GET /api/auth/me'
case "$LAST_BODY" in
*'"authLevel":"full"'*) pass 'the session reports authLevel=full' ;;
*) fail "unexpected /api/auth/me body: $LAST_BODY" ;;
esac

step '8. the password alone is not enough any more'
rm -f "$JAR"
request POST "${API}/auth/login" "{\"username\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}"
expect_status 200 'stage one still succeeds'
request GET "${API}/sessions"
expect_status 401 'but the pre session it yields still cannot read /api/sessions'

step '9. a wrong password and a wrong username are the same answer'
rm -f "$JAR"
request POST "${API}/auth/login" "{\"username\":\"${USERNAME}\",\"password\":\"definitely-not-the-password\"}"
WRONG_PASSWORD_STATUS="$LAST_STATUS"
WRONG_PASSWORD_BODY="$LAST_BODY"
rm -f "$JAR"
request POST "${API}/auth/login" '{"username":"nosuchuser","password":"definitely-not-the-password"}'
if [ "$LAST_STATUS" = "$WRONG_PASSWORD_STATUS" ] && [ "$LAST_BODY" = "$WRONG_PASSWORD_BODY" ]; then
  pass "byte-identical ($LAST_STATUS $LAST_BODY) for a wrong password and an unknown user"
else
  fail "wrong password gave $WRONG_PASSWORD_STATUS/$WRONG_PASSWORD_BODY, unknown user gave $LAST_STATUS/$LAST_BODY"
fi

printf '\n'
if [ "$FAILURES" -eq 0 ]; then
  printf 'All container smoke checks passed.\n'
  exit 0
fi
printf '%d container smoke check(s) failed.\n' "$FAILURES" >&2
exit 1
