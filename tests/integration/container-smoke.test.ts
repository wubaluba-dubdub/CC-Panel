import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `scripts/container-smoke.sh`, for the two things only a source-level harness can prove.
 *
 * The script's own assertions need a running container and are untouched by this file. What it
 * cannot prove from inside a container are two of its *own* contracts, both of which were
 * broken and both of which still passed their steps:
 *
 *  1. **A step reads the response it is about.** The deep-link step issued the HTML request,
 *     then a second request that overwrote `LAST_BODY` with the JSON 404, and only then
 *     pattern-matched `id="root"` — against the 404. Here the step's own text is executed with
 *     a stub transport that hands back a shell first and a 404 second, so an ordering that
 *     reads the wrong body records a `FAIL` instead of quietly passing on the wrong string.
 *  2. **A missing cookie jar is an empty token, not an awk fatal.** Every fresh login starts
 *     with `rm -f "$JAR"`, and curl does not recreate it until a response sets a cookie, so
 *     `cookie_from_jar` runs on a path that does not exist yet. The functions are executed in
 *     real bash here — with the script's own `set -uo pipefail` — because stderr is the whole
 *     assertion and a source scan cannot see it.
 *
 * What neither can see: that curl sends what the script thinks it sends, that the server
 * answers as documented, or that the container boots. That is `npm run smoke:container`.
 */

const SCRIPT = readFileSync(new URL('../../scripts/container-smoke.sh', import.meta.url), 'utf-8');

/** One shell function, from its definition to the brace that closes it at column zero. */
function functionSource(name: string): string {
  const start = SCRIPT.indexOf(`\n${name}() {`);
  expect(start, `${name}() was not found in container-smoke.sh`).toBeGreaterThan(-1);
  const close = SCRIPT.indexOf('\n}', start);
  expect(close, `${name}() has no closing brace`).toBeGreaterThan(start);
  return SCRIPT.slice(start + 1, close + 2);
}

/** The body of one `step`, from its marker to the marker of the step that follows it. */
function stepSource(marker: string, next: string): string {
  const start = SCRIPT.indexOf(marker);
  expect(start, `${marker} was not found in container-smoke.sh`).toBeGreaterThan(-1);
  const end = SCRIPT.indexOf(next, start);
  expect(end, `${next} was not found after ${marker}`).toBeGreaterThan(start);
  return SCRIPT.slice(start, end);
}

interface Run {
  stdout: string;
  stderr: string;
  status: number | null;
}

function bash(snippet: string): Run {
  const result = spawnSync('bash', ['-c', snippet], { encoding: 'utf-8' });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

let fixtures = '';

beforeEach(() => {
  fixtures = mkdtempSync(join(tmpdir(), 'panel-smoke-script-'));
});

afterEach(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

/** The two functions the script reads cookies through, wired to `jar` under the script's own `set`. */
function jarReader(jar: string): string {
  return `set -uo pipefail
JAR='${jar}'
${functionSource('cookie_from_jar')}
${functionSource('csrf_from_jar')}
`;
}

describe('container-smoke: a jar that does not exist yet', () => {
  it('yields an empty token and no awk fatal on stderr', () => {
    // The state step 7, 8 and 9 each start from: `rm -f "$JAR"`, and the next `request` reads
    // the CSRF token out of the jar before curl has had a chance to create it.
    const missing = join(fixtures, 'never-created');
    const run = bash(`${jarReader(missing)}
printf '%s' "$(csrf_from_jar)"
`);

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr, 'awk complained about a jar that is legitimately not there yet').toBe('');
  });

  it('still reads the real cookies when the jar is there', () => {
    // The guard must not become the reason a token goes unread: the loopback and the https
    // profiles use different cookie names, and an HttpOnly session line is only visible once
    // the `#HttpOnly_` prefix has been taken off its domain field.
    const jar = join(fixtures, 'jar');
    const read = (script: string): string => bash(`${jarReader(jar)}${script}`).stdout;

    writeFileSync(
      jar,
      [
        '#HttpOnly_127.0.0.1\tTRUE\t/\tFALSE\t0\tpanel_session\tsession-value',
        '#HttpOnly_127.0.0.1\tTRUE\t/\tFALSE\t0\tpanel_csrf\tloopback-token',
        'example.com\tFALSE\t/\tTRUE\t0\t__Secure-panel_csrf\tsecure-token',
      ].join('\n') + '\n',
    );
    expect(read(`printf '%s' "$(cookie_from_jar panel_session)"\n`)).toBe('session-value');
    // Both CSRF spellings present: the loopback one is the one a browser echoes back.
    expect(read(`printf '%s' "$(csrf_from_jar)"\n`)).toBe('loopback-token');

    // And the profile that has no `panel_csrf` at all still finds the `__Secure-` spelling.
    writeFileSync(jar, 'example.com\tFALSE\t/\tTRUE\t0\t__Secure-panel_csrf\tsecure-token\n');
    expect(read(`printf '%s' "$(csrf_from_jar)"\n`)).toBe('secure-token');
  });
});

describe('container-smoke: the deep-link step reads the response it is about', () => {
  /** The step, run verbatim against a `request` that answers shell-then-404 like the server. */
  function replay(): Run {
    return bash(`set -uo pipefail
BASE_URL='http://example.test'
BASE_PATH='bp'
LAST_STATUS=''
LAST_BODY=''
LAST_HEADERS=''
PASSES=()
FAILURES=()
REQUESTS=0

step() { :; }
pass() { PASSES+=("$1"); }
fail() { FAILURES+=("$1"); }
expect_status() {
  if [ "$LAST_STATUS" = "$1" ]; then pass "$2 → $LAST_STATUS"
  else fail "$2 → expected $1, got $LAST_STATUS"; fi
}
request() {
  REQUESTS=$((REQUESTS + 1))
  if [ "$REQUESTS" -eq 1 ]; then
    LAST_STATUS=200
    LAST_BODY='<div id="root"></div>'
  else
    LAST_STATUS=404
    LAST_BODY='{"error":"Not Found","code":"not_found"}'
  fi
}

${stepSource("step '2c. a deep link", "step '3. stage one")}

printf 'REQUESTS=%d PASSES=%d FAILURES=%d\\n' "$REQUESTS" "\${#PASSES[@]}" "\${#FAILURES[@]}"
if [ "\${#PASSES[@]}" -gt 0 ]; then printf 'PASS:%s\\n' "\${PASSES[@]}"; fi
if [ "\${#FAILURES[@]}" -gt 0 ]; then printf 'FAIL:%s\\n' "\${FAILURES[@]}"; fi
`);
  }

  it('matches the shell out of the HTML response, not out of the 404 that follows it', () => {
    const run = replay();

    expect(run.status, run.stderr).toBe(0);
    // Both requests still happen, in this order: the check that sits between them is the point,
    // so a fix that deleted the second request would also pass a "the body was checked" test.
    expect(run.stdout).toContain('REQUESTS=2');
    expect(run.stdout).toContain('FAILURES=0');
    expect(run.stdout).toContain("PASS:the deep link returns the shell");
    expect(run.stdout).toContain("PASS:GET a client route that no server route matches → 200");
    expect(run.stdout).toContain('PASS:GET the same path without asking for HTML → 404');
    expect(run.stdout).not.toContain('FAIL:');
  });
});
