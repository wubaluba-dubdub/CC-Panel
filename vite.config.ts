import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The client build.
 *
 * ── The base path is a build-time problem with a runtime answer ──────────────
 *
 * The panel is served under `/<basePath>/`, and the base path is secret, per
 * installation, and chosen at *runtime* — it does not exist when this build runs. Vite
 * emits absolute asset URLs from `base`, so `base` has to be something, and the two
 * obvious somethings are both wrong:
 *
 * - `base: './'` (relative URLs) works at `/<basePath>/` and breaks at
 *   `/<basePath>/security`, where `./assets/…` resolves to
 *   `/<basePath>/security/assets/…`. A deep link that works until it is refreshed is
 *   worse than one that never works.
 * - `<base href="…">` is unavailable: the CSP carries `base-uri 'none'`, which is what
 *   ruled the element out in M1.2 and has not changed.
 *
 * So `base` is a **sentinel** that cannot occur in real content, and the server
 * substitutes the resolved prefix into `index.html` once at boot — the same mechanism
 * `bootstrap.js` has used since M1.2, applied to one more file. Regenerating the base
 * path already answers `restartRequired: true`, so the cached string cannot go stale
 * without a restart. `tests/integration/build.test.ts` asserts the file on disk still
 * contains the sentinel and `tests/integration/client-shell.test.ts` asserts the served
 * body does not: a sentinel that reaches the browser is a broken page, and a base path
 * baked into a file on disk is a secret in the image.
 *
 * ── CSS is relative, and that is not a style choice ──────────────────────────
 *
 * A stylesheet is served by `@fastify/static` straight off disk — it is *not* templated,
 * so a sentinel inside `url(…)` would reach the browser and 404. `renderBuiltUrl` returns
 * `{ relative: true }` for CSS, and a `url()` in CSS resolves against the **stylesheet's**
 * own URL rather than the document's, so `url(vazirmatn-abc123.woff2)` inside
 * `/<base>/assets/index-def456.css` resolves correctly under any prefix and at any route
 * depth. The one case relative URLs get wrong is exactly the case CSS does not have.
 *
 * ── Everything else here is a CSP consequence ────────────────────────────────
 *
 * `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'` with no
 * `unsafe-inline`, no `unsafe-eval` and no `worker-src`:
 *
 * - `assetsInlineLimit: 0` — an inlined font is a `data:` URL, and `font-src 'self'` has
 *   no `data:` in it. `img-src` would tolerate one; one rule is better than two.
 * - `cssCodeSplit: false` — one stylesheet, linked, never injected.
 * - `modulePreload.polyfill: false` — the polyfill exists for browsers that need
 *   `<link rel=modulepreload>` shimmed, and there is nothing to preload: one entry, no
 *   dynamic imports, one chunk.
 * - **No dev server.** It injects inline styles and inline module scripts and needs a
 *   WebSocket for HMR — three violations of the shipped policy — so the thing the
 *   operator tested would not be the thing that ships, on a project whose whole perimeter
 *   is exact header, cookie and origin behaviour. `npm run dev` builds this and serves it
 *   from Fastify on one origin under the identical CSP; `npm run dev:client` is
 *   `vite build --watch`, which changes nothing about how the browser receives the page.
 */

/** The stand-in for the runtime base path. Must not occur in real content. */
export const BASE_PATH_SENTINEL = '__PANEL_BASE__';

export default defineConfig({
  root: 'src/client',
  base: `/${BASE_PATH_SENTINEL}/`,
  plugins: [react()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    target: 'es2022',
    sourcemap: false,
    // The bundle carries no secret, but it does carry the shape of every route and every
    // error code. A source map is a second copy of the source in the image for no
    // operational benefit — nothing debugs this in production.
    minify: 'esbuild',
    reportCompressedSize: false,
  },
  experimental: {
    renderBuiltUrl(_filename, { hostType }) {
      // See the CSS note above. `undefined` keeps Vite's default (`base` + filename) for
      // HTML and JS, which is what the sentinel substitution then rewrites.
      if (hostType === 'css') return { relative: true };
      return undefined;
    },
  },
});
