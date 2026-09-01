import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SERVER_ROOT = join(import.meta.dirname, '..', '..', 'src', 'server');

/**
 * The only file allowed to name a cookie or assemble its attributes.
 *
 * This is the M1.4 client-ip scan applied to a second architectural rule. The rule
 * exists because the previous arrangement — the name a constant in
 * `services/session.service.ts`, the attributes a helper in `plugins/auth.ts` that
 * hard-coded `secure: true` — spread one decision across two files and left the
 * `__Secure-` prefix unusable over loopback http with nobody owning the fix.
 *
 * Anything else appearing in the offender list is the finding, not the exemption.
 * Widening this set is the change a reviewer should be looking at.
 */
const COOKIE_OWNERS = new Set(['plugins/cookies.ts']);

const COOKIE_PATTERNS: { name: string; pattern: RegExp }[] = [
  // A cookie name spelled anywhere but the owner: the bare names, the prefixed
  // spellings, and the prefixes themselves.
  { name: 'cookie-name literal', pattern: /panel_session|panel_csrf/ },
  { name: 'cookie name prefix', pattern: /__Secure-|__Host-/ },
  // Writing a cookie without going through the jar, which is how an attribute set
  // gets assembled a second time.
  { name: 'setCookie / clearCookie', pattern: /\.\s*(?:setCookie|clearCookie)\s*\(/ },
  // Reading the jar directly, which is how a name literal comes back.
  { name: 'req.cookies', pattern: /\b(?:req|request|_req)\s*\.\s*cookies\b/ },
  // Hand-rolling the header, which bypasses @fastify/cookie's serialiser too.
  { name: "set-cookie header", pattern: /['"`]set-cookie['"`]/i },
  // Attribute names, which only appear in an attribute set.
  { name: 'sameSite attribute', pattern: /\bsameSite\b|SameSite=/ },
  { name: 'httpOnly attribute', pattern: /\bhttpOnly\b/ },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('M1.5 part 0 — one owner for every cookie', () => {
  it('names and attributes cookies in exactly one file', () => {
    const files = sourceFiles(SERVER_ROOT);
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SERVER_ROOT, file).split('\\').join('/');
      if (COOKIE_OWNERS.has(rel)) continue;

      const lines = readFileSync(file, 'utf-8').split('\n');
      for (const [index, line] of lines.entries()) {
        // Prose about the policy is the point of the policy; only code counts.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        for (const { name, pattern } of COOKIE_PATTERNS) {
          if (pattern.test(code)) offenders.push(`${rel}:${index + 1} (${name}) ${code.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('scans code that would fail it — the patterns are not vacuous', () => {
    // Each pattern matched against the shape it is meant to catch, so a typo that
    // made one of them unmatchable is caught here rather than passing silently.
    const samples: Record<string, string> = {
      'cookie-name literal': `const name = 'panel_session';`,
      'cookie name prefix': `const n = '__Secure-panel_session';`,
      'setCookie / clearCookie': `reply.setCookie(name, token, opts);`,
      'req.cookies': `const token = req.cookies[name];`,
      'set-cookie header': `reply.header('set-cookie', value);`,
      'sameSite attribute': `{ sameSite: 'strict' }`,
      'httpOnly attribute': `{ httpOnly: true }`,
    };
    for (const { name, pattern } of COOKIE_PATTERNS) {
      expect(pattern.test(samples[name]!), name).toBe(true);
    }
    expect(Object.keys(samples)).toHaveLength(COOKIE_PATTERNS.length);
  });

  it('has no cookie helper left behind in the auth plugin', () => {
    const auth = readFileSync(join(SERVER_ROOT, 'plugins', 'auth.ts'), 'utf-8');
    for (const gone of ['sessionCookieOptions', 'setSessionCookie', 'clearSessionCookie']) {
      expect(auth, gone).not.toContain(gone);
    }
  });
});
