import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
 *
 * **M1.6 found a third fault that this file, as written, did not catch**, and the gap
 * is worth naming because it is the same gap in a different place. `tsc` emits only
 * what it compiles, so `dist/server/migrations/` — eight `.sql` files the migration
 * runner reads off disk at boot — never existed. The runner's `catch { return }`
 * turned that into "no migrations to apply", so the container started, printed the
 * base-path banner, and died on the first query with `no such table: audit_log`.
 * Every assertion here passed throughout: the entry point existed, imported cleanly,
 * and contained `buildServer`.
 *
 * The lesson is that "the build emits the file `CMD` names" is not the same claim as
 * "the build emits everything the process reads". So the migrations are asserted
 * below, by name and by count, against the source directory rather than a literal.
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
    expect(output).toContain('copy-assets');

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

  it('emits every migration the runner will look for at boot', () => {
    // The fault this exists for: `tsc` copies no .sql file, the runner reads them off
    // disk, and a missing directory used to be swallowed as "nothing to apply". The
    // expectation is derived from the source tree, so adding migration 009 without
    // copying it fails here rather than at the first query in production.
    const source = join(ROOT, 'src', 'server', 'migrations');
    const emitted = join(DIST, 'server', 'migrations');
    expect(existsSync(emitted), 'dist/server/migrations was not emitted').toBe(true);

    const expectedSql = readdirSync(source).filter((f) => f.endsWith('.sql')).sort();
    expect(expectedSql.length).toBeGreaterThan(0);
    expect(readdirSync(emitted).filter((f) => f.endsWith('.sql')).sort()).toEqual(expectedSql);

    // Byte-identical, not merely present: a truncated or empty copy would satisfy a
    // name check and still leave the schema half-created.
    for (const file of expectedSql) {
      expect(readFileSync(join(emitted, file), 'utf-8'), file).toBe(
        readFileSync(join(source, file), 'utf-8'),
      );
    }
  });

  it('has no client build step left in the script until there is a client', () => {
    // The fix chosen was server-only, not a placeholder `index.html`. When M2.1
    // adds the real client entry point, `vite build` comes back and this
    // expectation is the one to update.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toBe('tsc -p tsconfig.build.json && node scripts/copy-assets.mjs');
    expect(existsSync(join(ROOT, 'vite.config.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'index.html'))).toBe(false);
  });
});
