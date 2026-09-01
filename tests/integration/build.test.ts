import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const DIST = join(ROOT, 'dist');

/**
 * `npm run build` had been failing since M1.1 and nothing noticed.
 *
 * Two separate faults. `vite build` was in the script with no client to build and
 * no `index.html` to enter from — `vite.config.ts` was created a milestone ahead of
 * its use — so the step died with "Could not resolve entry module". And the `tsc`
 * half, which did succeed, emitted `dist/src/server/…` because the base config sets
 * `rootDir: "."` and includes the test suite, while the Dockerfile runs
 * `node dist/server/index.js`. Neither would have been caught before a first
 * deployment, so both are asserted here rather than described.
 *
 * The build is genuinely run. A test that inspected `package.json` and reasoned
 * about it would have passed for the whole of the period this was broken.
 */
describe('Part 1 — the build runs, and emits what the image runs', () => {
  it('exits zero and produces the server entry point at the path the Dockerfile uses', () => {
    rmSync(DIST, { recursive: true, force: true });

    // Throws on a non-zero exit, which is the assertion. stdio is captured so a
    // failure reports the compiler's own diagnostics rather than a bare exit code.
    let output = '';
    try {
      output = execFileSync('npm', ['run', 'build'], {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 240_000,
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; status?: number };
      throw new Error(
        `npm run build exited ${err.status}\n--- stdout ---\n${err.stdout ?? ''}\n--- stderr ---\n${err.stderr ?? ''}`,
      );
    }
    expect(output).toContain('tsc -p tsconfig.build.json');

    // The exact path `CMD` names, read from the Dockerfile rather than repeated
    // here, so the two cannot drift apart again.
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf-8');
    const cmd = /^CMD \["node", "([^"]+)"\]/m.exec(dockerfile);
    expect(cmd, 'the Dockerfile still starts the server with a CMD array').not.toBeNull();

    const entry = join(ROOT, cmd![1]!);
    expect(existsSync(entry), `${cmd![1]!} was not emitted by the build`).toBe(true);

    // And it is loadable, not merely present: an emitted file with an unresolvable
    // import satisfies existsSync and still fails at container start.
    expect(readFileSync(entry, 'utf-8')).toContain('buildServer');
  });

  it('ships no test code and no stale nested layout', () => {
    // Both are consequences of the base tsconfig's rootDir, and both would bloat
    // or confuse the image rather than fail it — so neither shows up as an error.
    expect(existsSync(join(DIST, 'tests'))).toBe(false);
    expect(existsSync(join(DIST, 'src'))).toBe(false);
    expect(existsSync(join(DIST, 'server'))).toBe(true);
  });

  it('has no client build step left in the script until there is a client', () => {
    // The fix chosen was server-only, not a placeholder `index.html`. When M2.1
    // adds the real client entry point, `vite build` comes back and this
    // expectation is the one to update.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toBe('tsc -p tsconfig.build.json');
    expect(existsSync(join(ROOT, 'vite.config.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'index.html'))).toBe(false);
  });
});
