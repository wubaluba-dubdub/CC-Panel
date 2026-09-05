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
  /**
   * Four minutes, not the suite's 30-second default.
   *
   * This test really runs `tsc` over the whole server, and it shares the machine with
   * every other test file vitest has in flight. On an idle machine it takes about three
   * seconds; in a full-suite run under load it has been measured at 31 s, which failed as
   * a *timeout* reported next to an unrelated assertion — an hour of looking in the wrong
   * place. The `execFileSync` timeout below is the real bound.
   */
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
    // The client half, new in M2.1. `vite build` was in this script for a milestone before
    // any client existed and failed with "Could not resolve entry module"; now there is one.
    expect(output).toContain('vite build');

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
  }, 240_000);

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

  it('builds both halves, and the client entry point is where Vite is pointed', () => {
    // M1.5 deleted `vite.config.ts` because `vite build` was in this script a milestone
    // before any client existed. M2.1 brings both back, and this is the assertion that has
    // to move with them.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    // The order is load-bearing: `vite build` empties `dist/client`, and `copy-assets` puts
    // the font licences into it, so the copy has to be last.
    expect(pkg.scripts.build).toBe(
      'tsc -p tsconfig.build.json && vite build && node scripts/copy-assets.mjs',
    );
    expect(existsSync(join(ROOT, 'vite.config.ts'))).toBe(true);
    // Still not at the repository root: Vite's `root` is `src/client`, so an `index.html`
    // here would be a second entry point nothing builds.
    expect(existsSync(join(ROOT, 'index.html'))).toBe(false);
    expect(existsSync(join(ROOT, 'src', 'client', 'index.html'))).toBe(true);
    // `npm run typecheck` covers both halves. One config cannot: the server has `node` types
    // and no DOM, the client has the DOM and must not be able to reach `node:fs`.
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit && tsc --noEmit -p tsconfig.client.json');
  });
});

/**
 * The client output, asserted on the **built file** rather than on the source.
 *
 * This is the part of the milestone the rest of the suite cannot reach. Every check here is
 * a CSP consequence, and every one of them fails in a browser as a silent console message
 * and a page that is blank or unstyled — which is exactly what `app.inject()` cannot see.
 *
 * They are written *generically* on purpose. "Zero inline `<script>`" catches every future
 * change in Vite's output; enumerating today's known injections would pass the day a new one
 * appears. `tests/integration/build.test.ts` runs the real build above, so this describes
 * what a deployment would actually carry.
 */
describe('Part 1 — the client build satisfies the shipped CSP', () => {
  const CLIENT = join(DIST, 'client');

  function indexHtml(): string {
    return readFileSync(join(CLIENT, 'index.html'), 'utf-8');
  }

  it('emits the shell and its assets where the server looks for them', () => {
    // The server resolves `dist/client` as a sibling of `dist/server` — see
    // `resolveClientDir`. If that ever stops being true, the panel serves the
    // "not built" diagnostic on a deployment that built cleanly.
    expect(existsSync(join(CLIENT, 'index.html'))).toBe(true);
    const assets = readdirSync(join(CLIENT, 'assets'));
    expect(assets.some((f) => f.endsWith('.js')), 'no JS asset was emitted').toBe(true);
    expect(assets.some((f) => f.endsWith('.css')), 'no CSS asset was emitted').toBe(true);
    // Content-hashed, which is what makes the year-long immutable cache directive safe.
    for (const file of assets) {
      expect(file, `${file} is not content-hashed`).toMatch(/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/);
    }
  });

  it('leaves the sentinel in the file on disk and in every asset reference', () => {
    // Both halves matter. A base path baked into a file on disk is a secret in the image;
    // a sentinel that reaches the browser is a page whose script tag 404s. This asserts the
    // first half — `tests/integration/base-path.test.ts` asserts the second on the *served*
    // body, which is the only place the substitution can be observed.
    const html = indexHtml();
    expect(html).toContain('__PANEL_BASE__');

    const refs = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(1);
    for (const ref of refs) {
      expect(ref, `${ref} is not prefixed with the sentinel`).toMatch(/^\/__PANEL_BASE__\//);
    }
  });

  it('has no inline script, no inline style, and no style attribute', () => {
    const html = indexHtml();

    // `script-src 'self'` with no `unsafe-inline`. A blocked inline script is a page that
    // renders nothing, with one line in a console the test suite does not have.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    // `style-src 'self'` with no `unsafe-inline`. Both of these are blocked, and the failure
    // is an unstyled page rather than an error.
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle="/i);
  });

  it('inlines nothing as a data: URL, because font-src has no data:', () => {
    // `assetsInlineLimit: 0`. `img-src` would tolerate an inlined image and `font-src` would
    // not, and one rule is better than two — so nothing is inlined at all.
    const css = readdirSync(join(CLIENT, 'assets'))
      .filter((f) => f.endsWith('.css'))
      .map((f) => readFileSync(join(CLIENT, 'assets', f), 'utf-8'))
      .join('\n');
    expect(css.length).toBeGreaterThan(0);
    expect(css, 'a data: URL in the emitted CSS').not.toContain('data:');
    expect(indexHtml(), 'a data: URL in the shell').not.toContain('data:');
  });

  it('ships the font licences beside the fonts, because the OFL requires it', () => {
    // Vite emits the woff2 files (hashed, into `assets/`) and emits nothing for a `.txt` that
    // no module imports. So the licences are copied — and `copy-assets` runs after
    // `vite build` for exactly that reason, since `emptyOutDir` would delete them.
    for (const licence of ['OFL-Vazirmatn.txt', 'OFL-JetBrainsMono.txt']) {
      const file = join(CLIENT, licence);
      expect(existsSync(file), `${licence} was not emitted`).toBe(true);
      expect(readFileSync(file, 'utf-8')).toContain('SIL Open Font License');
    }
    // And the fonts they cover are actually there, so the pairing is not vacuous.
    const fonts = readdirSync(join(CLIENT, 'assets')).filter((f) => f.endsWith('.woff2'));
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.some((f) => f.startsWith('vazirmatn-'))).toBe(true);
    expect(fonts.some((f) => f.startsWith('jetbrains-mono-'))).toBe(true);
  });

  it('keeps every font URL relative, because a stylesheet is never templated', () => {
    // The one place a sentinel would reach the browser. `@fastify/static` serves the
    // stylesheet straight off disk, so a `/__PANEL_BASE__/…` inside `url()` would 404 — and a
    // *relative* URL resolves against the stylesheet's own address, which is correct under any
    // prefix and at any route depth. `renderBuiltUrl` in vite.config.ts is what does it.
    const css = readdirSync(join(CLIENT, 'assets'))
      .filter((f) => f.endsWith('.css'))
      .map((f) => readFileSync(join(CLIENT, 'assets', f), 'utf-8'))
      .join('\n');
    expect(css).not.toContain('__PANEL_BASE__');
    const urls = [...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]!.replace(/["']/g, ''));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url, `${url} is not relative`).toMatch(/^\.\//);
    }
  });

  it('emits no source map, and no reference to one', () => {
    // A source map is a second copy of the client source in the image, and nothing debugs
    // this in production. The comment is what a browser follows, so its absence is the check.
    const files = readdirSync(join(CLIENT, 'assets'));
    expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
    for (const file of files) {
      expect(readFileSync(join(CLIENT, 'assets', file), 'utf-8')).not.toContain('sourceMappingURL');
    }
  });
});
