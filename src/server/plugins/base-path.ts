import type { FastifyPluginAsync, onRequestAsyncHookHandler } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import fp from 'fastify-plugin';
import { firstPathSegment, pathnameOf, timingSafeEqualStrings } from '../utils/timing-safe.js';

interface BasePathOptions {
  basePath: string;
  /** Where the built client lives. See {@link resolveClientDir}. */
  clientDir: string;
  /** `window.__LOCALE__`, resolved per request from `Accept-Language` or the stored value. */
  localeFor?: (req: { headers: Record<string, unknown> }) => 'en' | 'fa';
  /** The name of the CSRF cookie, which the client must not guess. */
  csrfCookieName: string;
  /**
   * Charged against the shared anonymous bucket for the shell and `bootstrap.js`.
   *
   * Handed in rather than installed by the caller because Fastify hooks are scoped:
   * a hook added at the root would also cover the API, where the per-session bucket
   * is the right one. Passing it here puts it inside this plugin's nested scope and
   * nowhere else.
   */
  rateLimit?: onRequestAsyncHookHandler | undefined;
}

/**
 * Every request whose first path segment is not the base path is rewritten to
 * this single constant before routing, so the router traverses an identical URL
 * for every rejected request and returns the generic 404. Nothing is mounted
 * here; a client asking for it directly is itself rewritten to it.
 */
export const NOT_FOUND_SINK = '/__panel_not_found';

/** The only path served outside the base path. */
export const HEALTHZ_PATH = '/healthz';

/**
 * Builds the `rewriteUrl` hook that gates the secret base path (F7).
 *
 * `rewriteUrl` is the one Fastify hook that runs *before* routing, which matters
 * here: find-my-way's radix traversal is not constant-time, so a gate placed in
 * `onRequest` would run after the router had already produced a measurable
 * partial-match signal. Rejecting here means every wrong prefix — regardless of
 * how many leading characters it got right — is collapsed onto one constant URL
 * and takes the same path through the router.
 *
 * Matching requests are returned unchanged rather than rewritten onto an
 * internal mount, so `req.url` stays truthful and anything that derives a URL
 * from it (redirects, `@fastify/static` in Phase 2) keeps emitting links a
 * browser can follow.
 *
 * The comparison is on the raw, undecoded segment: `/%73ecret` is a miss, not a
 * hit. That is deliberate — canonicalising first would open the door to the
 * class of prefix-confusion bypasses that @fastify/static v7 was vulnerable to.
 */
export function createBasePathGate(basePath: string): (req: IncomingMessage) => string {
  return function rewriteUrl(req: IncomingMessage): string {
    const rawUrl = req.url ?? '/';
    const pathname = pathnameOf(rawUrl);

    // /healthz is public and constant — no secret to protect, plain compare.
    if (pathname === HEALTHZ_PATH) return rawUrl;

    const segment = firstPathSegment(pathname);
    if (segment === null) return NOT_FOUND_SINK;
    if (!timingSafeEqualStrings(segment, basePath)) return NOT_FOUND_SINK;

    return rawUrl;
  };
}

/** Escapes a string for interpolation into a double-quoted HTML attribute. */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The bootstrap script body (F1).
 *
 * This cannot be an inline `<script>`: the CSP is `script-src 'self'` with no
 * `unsafe-inline`, so the browser refuses to execute it. A CSP hash is not an
 * option either — the script embeds the base path, which differs per install,
 * so any hash committed to the repo would only ever be correct on the machine
 * that generated it.
 *
 * `JSON.stringify` rather than string concatenation on every value: `PANEL_BASE_PATH` is
 * operator-supplied and unvalidated, so it must not be able to terminate the string
 * literal, and the same rule is applied to the other two for free.
 *
 * ── Why the locale and the direction are set here and not in React ──────────
 *
 * This script is a classic script in `<head>` with no `defer`, and the bundle is a module,
 * and modules are always deferred. So this runs **before first paint**, which is what turns
 * "no left-to-right flash on a Persian page" from a race React can lose into a structural
 * property. React sets neither `lang` nor `dir`; it reads them.
 *
 * The stored preference is cached in `localStorage` and applied here too, so the only
 * wrong-direction frame anybody ever sees is on a brand-new browser profile whose
 * `Accept-Language` disagrees with the stored choice. This deliberately does **not** read
 * the session to find the stored locale: that would put a database read on an
 * unauthenticated route, which `routes/api.ts` avoids on purpose.
 *
 * ── Why the CSRF cookie's *name* is here ────────────────────────────────────
 *
 * It is `__Secure-panel_csrf` over https and `panel_csrf` over loopback http, and
 * `plugins/cookies.ts` is the only file allowed to decide which. A client that hard-coded
 * either spelling would work on one deployment and fail on the other as a 403 on every
 * mutation — with a correct-looking cookie in the jar and nothing in the console.
 */
export function renderBootstrapScript(opts: {
  basePath: string;
  locale: 'en' | 'fa';
  csrfCookieName: string;
}): string {
  return [
    `window.__BASE__ = ${JSON.stringify(`/${opts.basePath}`)};`,
    `window.__CSRF_COOKIE__ = ${JSON.stringify(opts.csrfCookieName)};`,
    // The server's guess, then the browser's memory of an explicit choice. `try` because
    // `localStorage` throws outright in a partitioned or storage-blocked context, and a
    // panel that will not boot because a privacy setting is on is not a trade worth making.
    `window.__LOCALE__ = ${JSON.stringify(opts.locale)};`,
    'try {',
    `  var stored = window.localStorage.getItem('panel.locale');`,
    `  if (stored === 'en' || stored === 'fa') window.__LOCALE__ = stored;`,
    '} catch (e) { /* storage unavailable; the server guess stands */ }',
    `document.documentElement.lang = window.__LOCALE__;`,
    `document.documentElement.dir = window.__LOCALE__ === 'fa' ? 'rtl' : 'ltr';`,
    '',
  ].join('\n');
}

// ─── The shell ───────────────────────────────────────────────────────────────

/**
 * The stand-in `vite build` writes into every absolute asset URL.
 *
 * Duplicated from `vite.config.ts` rather than imported, and that is deliberate: importing
 * it would pull the Vite config — and Vite — into the server's compile graph and into the
 * runtime image. `tests/integration/build.test.ts` asserts the two agree by finding this
 * exact string in the built `index.html`, which is a stronger check than a shared constant:
 * it fails if the *build output* stops containing it, not merely if someone edits one copy.
 */
export const BASE_PATH_SENTINEL = '__PANEL_BASE__';

/** The built client's directory, and how it is found. */
export function resolveClientDir(override?: string): string {
  if (override !== undefined) return override;
  // `dist/client` is a sibling of `dist/server`, and this file is `dist/server/plugins/`.
  // Correct in the built tree, which is the only tree that ships. Under `tsx` it resolves
  // to `src/client`, which contains the *source* `index.html` — no sentinel in it, because
  // Vite has not run — and `loadShell` refuses that rather than serving a page whose
  // script tag is `/main.tsx`. `npm run dev` passes `PANEL_CLIENT_DIR=dist/client`.
  return join(import.meta.dirname, '..', '..', 'client');
}

/**
 * Why the shell could not be served, as a code.
 *
 * - `missing`      — no `index.html` at all: `vite build` never ran, or `dist/client` was
 *                    not copied into the image.
 * - `no_sentinel`  — a file that exists and was not produced by this build. Under `tsx`
 *                    that is `src/client/index.html`, whose script tag points at
 *                    `/main.tsx`; in a built tree it is a stale or hand-edited file.
 */
export type ShellFault = 'missing' | 'no_sentinel';

export interface ShellLoad {
  readonly html: string | null;
  readonly fault: ShellFault | null;
}

/**
 * Reads `index.html` and substitutes the resolved prefix. Called **once**, at boot.
 *
 * Cached rather than templated per request because the base path is fixed for the life of
 * the process: regenerating it answers `restartRequired: true`, so the cached string cannot
 * go stale without a restart. One `readFileSync` at boot, no filesystem access per page.
 *
 * A missing or unrecognisable file is reported, never thrown. The API, `/healthz` and the
 * CLI all work without a client bundle, and a panel that refuses to boot because its
 * front-end is missing takes away the one interface that could have said so.
 */
export function loadShell(clientDir: string, basePath: string): ShellLoad {
  const file = join(clientDir, 'index.html');
  if (!existsSync(file)) return { html: null, fault: 'missing' };

  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return { html: null, fault: 'missing' };
  }
  if (!raw.includes(BASE_PATH_SENTINEL)) return { html: null, fault: 'no_sentinel' };

  return { html: templateShell(raw, basePath), fault: null };
}

/**
 * The substitution itself.
 *
 * A global replace of the bare token, so it covers the module script's `src`, the
 * stylesheet's `href` and `bootstrap.js` in one pass — and would cover anything a future
 * Vite emits from `base` without this function having to learn about it.
 *
 * **HTML-escaped**, because every occurrence is inside a double-quoted attribute and
 * `PANEL_BASE_PATH` is operator-supplied and unvalidated (`env.ts` takes it as a bare
 * string). A generated prefix is 22 characters of base64url and the escaping is a no-op on
 * it; a hand-set one containing a quote would otherwise terminate the attribute. This is
 * the same rule the M1.2 placeholder had, kept when the placeholder went away — which is
 * exactly the sort of thing a rewrite drops silently.
 */
export function templateShell(indexHtml: string, basePath: string): string {
  return indexHtml.split(BASE_PATH_SENTINEL).join(escapeHtmlAttribute(basePath));
}

/**
 * What is served when there is no client bundle.
 *
 * Not a blank page and not a 500. A blank page is the single hardest failure in this
 * milestone to diagnose, and this milestone is the first one whose mistakes are invisible
 * to the test suite — so the one case the server can *detect* says so in words, names the
 * command, and reports 200 because the request was served correctly and it is the deployment
 * that is incomplete. `scripts/container-smoke.sh` fails on it, which is where a broken
 * image is supposed to be caught.
 *
 * No inline style, no inline script: the CSP applies to this page exactly as it does to the
 * real one, and a diagnostic that is itself blocked would be worse than none.
 */
export function renderShellFault(fault: ShellFault): string {
  const detail =
    fault === 'missing'
      ? 'No client bundle was found. The server, the API and /healthz are running; only the interface is missing.'
      : 'A client index.html was found but was not produced by this build, so its asset URLs cannot be corrected for the base path.';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Panel — client bundle missing</title>
</head>
<body>
  <h1>The panel's interface has not been built</h1>
  <p>${detail}</p>
  <p>Run <code>npm run build</code> (which runs <code>vite build</code>) and restart.</p>
</body>
</html>`;
}

// ─── The SPA fallback ────────────────────────────────────────────────────────

/**
 * Whether an unmatched request should be answered with the shell rather than a 404.
 *
 * Four things have to hold at once, and they pull against each other:
 *
 *  - a `GET`/`HEAD` under the base path that accepts `text/html` and is **not** under
 *    `/api/` gets `index.html` with a 200, so a hard refresh of `/<base>/security` works;
 *  - an unknown path under `/api/` keeps the JSON 404, because a client that asked for JSON
 *    and got a page cannot report a useful error;
 *  - the wrong-base-path sink stays **byte-identical** to what it has always been — that is
 *    what keeps the prefix from being discoverable, and it is asserted in the perimeter
 *    tests;
 *  - anything that is not a GET, and anything that did not ask for HTML, behaves as before.
 *
 * This is one function inside the existing root not-found handler rather than a scoped
 * handler or a wildcard route, and that choice is load-bearing three ways. The base-path
 * gate already ran as `rewriteUrl` **before routing**, so a URL that still starts with the
 * prefix here has necessarily passed the constant-time compare — the sink is
 * `/__panel_not_found`, which fails the prefix test and takes the untouched path. A scoped
 * `setNotFoundHandler` under the base path would instead have run that scope's hooks,
 * charging every unknown `/api/` path against the *anonymous* bucket rather than the
 * session one. And a `/*` wildcard route would have had to be ordered against every real
 * route rather than being what runs when none matched.
 */
export function wantsShell(opts: {
  method: string;
  url: string;
  accept: string | undefined;
  basePath: string;
}): boolean {
  if (opts.method !== 'GET' && opts.method !== 'HEAD') return false;

  const pathname = pathnameOf(opts.url);
  const prefix = `/${opts.basePath}`;
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;
  if (pathname.startsWith(`${prefix}/api/`) || pathname === `${prefix}/api`) return false;

  // A browser navigation sends `Accept: text/html,…`; `fetch()` and `curl` do not unless
  // asked. So a missing or non-HTML `Accept` keeps the JSON 404 — which is what makes a
  // mistyped asset URL a 404 in the network panel instead of a page that renders and then
  // fails to parse as JavaScript.
  return (opts.accept ?? '').includes('text/html');
}

const basePathPlugin: FastifyPluginAsync<BasePathOptions> = async (fastify, opts) => {
  const { basePath, csrfCookieName } = opts;
  const shell = loadShell(opts.clientDir, basePath);
  const faultHtml = shell.fault === null ? null : renderShellFault(shell.fault);
  const body = shell.html ?? faultHtml!;

  if (shell.fault !== null) {
    fastify.log.error(
      { fault: shell.fault, clientDir: opts.clientDir },
      'no usable client bundle: serving the diagnostic shell',
    );
  }

  const assetsDir = join(opts.clientDir, 'assets');

  await fastify.register(
    async (scopedApp) => {
      if (opts.rateLimit !== undefined) scopedApp.addHook('onRequest', opts.rateLimit);

      /**
       * The shell.
       *
       * `no-store`, and it is the panel's **second** caching directive after `/healthz`.
       * The document carries the base path in three attributes and the hashed names of the
       * assets it needs, so a cached copy after a regenerated prefix or a redeploy is a page
       * that requests URLs which no longer exist — a blank screen with 404s in the network
       * panel and nothing in the console. The document is ~2 KB and uncacheable; the assets
       * it names are content-hashed and cached for a year, which is where the win is.
       */
      const sendShell = async (
        _req: unknown,
        reply: {
          type(v: string): typeof reply;
          header(k: string, v: string): typeof reply;
          send(v: string): unknown;
        },
      ): Promise<unknown> =>
        reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(body);

      scopedApp.get('/', sendShell);

      // Base path bootstrap: the only way to hand `window.__BASE__` to the client under a
      // strict CSP. Never cached — the base path can be regenerated, and the locale is
      // resolved per request.
      scopedApp.get('/bootstrap.js', async (req, reply) => {
        const locale = opts.localeFor?.(req) ?? 'en';
        return reply
          .type('application/javascript; charset=utf-8')
          .header('Cache-Control', 'no-store')
          .send(renderBootstrapScript({ basePath, locale, csrfCookieName }));
      });

      /**
       * The built assets, and only those.
       *
       * Scoped to `/assets/` rather than mounted at the prefix root, which is what keeps it
       * from shadowing the API and the shell. The wildcard inside that prefix is
       * `@fastify/static`'s serving mechanism; `wildcard: false` is the alternative and it
       * *globs the directory at boot and registers one route per file*, which would put
       * every content-hashed filename into `printRoutes()` and make the route tree change
       * on every build — `tests/integration/secret-leak.test.ts` pins that tree as a
       * literal.
       *
       * `immutable` with a one-year `max-age` is safe **because the filename contains a
       * hash of the contents**: a changed file is a changed URL, so there is nothing for a
       * stale cache to serve. This is the panel's third caching directive and the only
       * positive one.
       *
       * `etag`/`lastModified`/`acceptRanges` are off. A content-hashed immutable file needs
       * no validator — revalidation never happens — and switching them off is what makes
       * the response's header map deterministic, which is what lets
       * `tests/integration/perimeter.test.ts` assert it byte-for-byte rather than
       * approximately.
       */
      if (existsSync(assetsDir)) {
        await scopedApp.register(fastifyStatic, {
          root: assetsDir,
          prefix: '/assets/',
          index: false,
          list: false,
          redirect: false,
          dotfiles: 'deny',
          serveDotFiles: false,
          etag: false,
          lastModified: false,
          acceptRanges: false,
          cacheControl: true,
          immutable: true,
          maxAge: 31_536_000_000,
          // Nothing else in the panel calls `reply.sendFile`, and decorating the reply
          // object for one plugin's convenience is a global change for a local reason.
          decorateReply: false,
        });
      }
    },
    { prefix: `/${basePath}` },
  );
};

export default fp(basePathPlugin, {
  name: 'base-path',
});
