# The client — tokens, constraints, and the rules that are enforced

The interface built in M2.1: what it is made of, what the Content Security Policy forbids,
and where each rule is enforced rather than merely written down. Read this before adding a
component, a dependency, or a stylesheet.

`docs/SECURITY.md` is the authority for the header set and the manual browser checks;
`PLAN.md` §*M2.1* is the authority for the milestone's scope. This document is the
authority for how the client is built.

---

## 1. Design tokens

Defined once as custom properties in `src/client/styles/globals.css`. There is no second
place a colour or a spacing step may be written.

| | Value | Note |
| :--- | :--- | :--- |
| `--bg` | `#0a0a0b` | the page |
| `--surface` | `#131316` | a card, the navigation |
| `--surface-raised` | `#1b1b1f` | an input, a raised block |
| `--hairline` / `--hairline-strong` | `#26262b` / `#34343b` | borders; there are two, not five |
| `--text` / `--text-muted` / `--text-faint` | `#e8e8ea` / `#9a9aa2` / `#6b6b73` | three steps of ink |
| `--accent` | `#6e8bff` | **one** accent |
| `--danger` / `--warn` / `--ok` | `#ff6b6b` / `#ffb95c` / `#57d9a3` | status, and never the accent |
| `--s1`…`--s7` | 4, 8, 16, 24, 32, 48, 64 px | the 8px grid |
| `--radius-sm` / `--radius` / `--radius-lg` | 4 / 8 / 12 px | |
| `--t-fast` / `--t-slow` | 150 ms / 220 ms | |
| `--ease` | `cubic-bezier(0.2, 0, 0.2, 1)` | |

Three rules about them:

- **Three surfaces and no more.** A dark interface with six greys reads as noise, and every
  extra step is a decision to make at every component.
- **Status colours are not brand colours.** A red that is also the accent makes every button
  look like a warning.
- **Every transition is on `transform` and `opacity` only, and every one is inside
  `@media (prefers-reduced-motion: no-preference)`.** Nothing the operator has to *read*
  animates: a number that slides into place is a number they cannot compare with the one
  they were looking at.

**Plain CSS, not Tailwind**, departing from `PLAN.md` §M2.1 item 1. The deciding argument is
enforcement, not taste: R3's logical-property rule is only real if a static scan can see a
violation, and a scan over CSS declarations is exact where a scan over `className` strings
would have to encode Tailwind's whole utility vocabulary and would fail *silently* the first
time it missed one. Tailwind would also have put a native binary (`@tailwindcss/oxide`) in
the builder stage for a design system of about four hundred lines. Recorded as decision 23 in
`PLAN.md` §*Decisions taken in M2.1*.

---

## 2. What the CSP forbids, and what that costs

The policy is fixed, byte-identical in development and production, and asserted on seven
response shapes by `tests/integration/perimeter.test.ts`:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none';
form-action 'self'
```

| Directive | Consequence for the client |
| :--- | :--- |
| `script-src 'self'`, no `unsafe-inline` | No inline `<script>`, ever. `window.__BASE__` reaches the client as a **file** (`bootstrap.js`); a CSP hash is not usable because the body embeds the per-install prefix. |
| `style-src 'self'`, no `unsafe-inline` | No `<style>` element, no `style` attribute in served markup, no `setAttribute('style', …)`, no `style.cssText`. **No runtime CSS-in-JS** — the whole styled-components/emotion family is unusable regardless of nonce support, because a nonce would have to be per-response and the panel does no server-side rendering. |
| `font-src 'self'` | Fonts are same-origin files. `assetsInlineLimit: 0`, because an inlined font is a `data:` URL and this directive has no `data:` in it. |
| `img-src 'self' data:` | A `data:` image *would* be allowed. It is still not used: one rule is better than two. |
| `worker-src` absent → `default-src 'none'` | **No web workers.** This is why CodeMirror 6 is the decided editor for M2.4 and Monaco is not. Do not add `worker-src` to make an editor work. |
| `connect-src 'self'` | `fetch` to the panel's own origin only. Covers a same-origin WebSocket in modern browsers; Phase 3 verifies that in a real browser before adding `wss:`. |
| `base-uri 'none'` | `<base href>` is unavailable, which is what makes the base path a runtime templating problem (§3). |
| `frame-ancestors 'none'` | The panel cannot be framed. |

### The one data-driven component, and how it gets its number

MDN's `style-src-attr` page documents that setting properties on an element's `style`
*object* is **not** blocked — which is the CSSOM path React DOM uses for `style={{}}`, so
`style={{ width }}` would be expected to work. Expected is not guaranteed: browsers have
historically reported a violation for that path while still applying the style.

So the resource gauge sets a **custom property** through the API MDN documents as allowed:

```ts
element.style.setProperty('--gauge-fill', `${percent}%`);   // src/client/components/Gauge.tsx
```

```css
.gauge-bar { width: var(--gauge-fill); }                     /* globals.css */
```

No `style` attribute exists in the markup at any point. `tests/integration/client-discipline.test.ts`
forbids a `style` prop anywhere in `src/client`.

### There is no Vite dev server

It injects inline styles and inline module scripts and needs a WebSocket for HMR — three
violations of the shipped policy — so the thing the operator tested would not be the thing
that ships, on a project whose entire perimeter is exact header, cookie and origin
behaviour.

```
npm run dev          builds the client, then runs the server with tsx watch
npm run dev:client   vite build --watch, writing into dist/client
```

A client rebuild is **about 1.2 s** for the whole bundle. `vite build --watch` is acceptable
because it changes nothing about how the browser receives the page: same origin, same
headers, same cookies, same CSP.

---

## 3. The base path: a build-time problem with a runtime answer

Vite emits absolute asset URLs from `base`. The panel serves under `/<basePath>/`, and the
base path is secret, per-installation, and chosen at **runtime** — it does not exist when the
build runs. Two obvious answers are both wrong:

- **`base: './'`** works at `/<basePath>/` and breaks at `/<basePath>/security`, where
  `./assets/…` resolves to `/<basePath>/security/assets/…`. A deep link that works until it
  is refreshed is worse than one that never works.
- **`<base href="…">`** is unavailable: `base-uri 'none'`.

So `base` is the sentinel `__PANEL_BASE__`, and the server substitutes the resolved prefix
into `index.html` **once at boot** (`loadShell` in `src/server/plugins/base-path.ts`). The
cached string cannot go stale without a restart, because regenerating the prefix already
answers `restartRequired: true`.

Two assertions, in opposite directions, and both matter:

| Claim | Where |
| :--- | :--- |
| the sentinel is still in the file **on disk** | `tests/integration/build.test.ts`, `scripts/verify-image.sh` |
| the sentinel is **gone** from the served body | `tests/integration/base-path.test.ts`, `scripts/container-smoke.sh` |

A sentinel that reaches the browser is a page whose script tag 404s. A base path baked into
a file on disk is a per-installation secret in an image layer.

The substitution is **HTML-escaped**: every occurrence is inside a double-quoted attribute
and `PANEL_BASE_PATH` is operator-supplied and unvalidated. A generated 22-character
base64url prefix is untouched by the escaping.

### CSS is relative, and that is not a style choice

A stylesheet is served straight off disk by `@fastify/static` and is **never templated**, so
a sentinel inside `url()` would reach the browser. `renderBuiltUrl` in `vite.config.ts`
returns `{ relative: true }` for CSS, and a `url()` resolves against the *stylesheet's* own
URL rather than the document's — correct under any prefix and at any route depth. The one
case relative URLs get wrong is the case CSS does not have.

### The SPA fallback

`wantsShell()` in `plugins/base-path.ts`, called from the root not-found handler. Four things
hold at once:

- a `GET`/`HEAD` under the prefix that accepts `text/html` and is not under `/api/` returns
  `index.html` with 200, so a hard refresh of `/<base>/security` works;
- an unknown path under `/api/` keeps the JSON 404 — a client that asked for JSON and got a
  page cannot report a useful error;
- the wrong-base-path sink stays **byte-identical**, which is what keeps the prefix from
  being discoverable;
- non-GET and non-HTML requests behave as they did before.

It is in the root handler rather than a scoped `setNotFoundHandler` (which would run the
base-path scope's hooks and charge every unknown `/api/` path against the *anonymous* rate
bucket instead of the session one) and rather than a `/*` route (which would have to be
ordered against every real route instead of being what runs when none matched).

### Caching

Three directives in the whole panel, and this milestone added two of them:

| Response | Directive | Why |
| :--- | :--- | :--- |
| `/healthz` | `no-store` | M1.6. "The health endpoint said fine" must never come out of a cache. |
| the shell, `bootstrap.js` | `no-store` | Both name the base path and the shell names the hashed assets. A cached copy after a regenerated prefix or a redeploy is a blank page with 404s in the network panel and nothing in the console. ~2 KB, uncacheable. |
| `/<base>/assets/*` | `public, max-age=31536000, immutable` | Safe **because the filename contains a hash of the contents**: a changed file is a changed URL, so there is nothing for a stale cache to serve. `etag`, `last-modified` and `accept-ranges` are switched off — an immutable content-hashed file needs no validator, and their absence is what makes the header map assertable byte-for-byte. |

---

## 4. Persian, English, and direction

### `t()` returns a node, not a string

`src/client/i18n/translate.ts`. A Latin value inside a Persian sentence reorders visually
unless it is isolated, because the neutral characters at its edges — `/` `.` `-` `:` `(` —
resolve to the **paragraph's** direction rather than the run's:

```
raw (stored, unchanged):      پروژه در {path} ذخیره شد
without isolation, displays:  … data/projects/9f8e/workspace/ …   ← the leading "/" jumped
with <bdi>, displays:         … /data/projects/9f8e/workspace …
```

The string on disk is identical in both cases; only the visual order differs, which is why it
reads as a data error and gets reported as one. Every parameter is wrapped in `<bdi>` by
`t()` itself, and because the return value is a node **there is no string to concatenate a
machine value into**.

`ts()` is the string form, for `aria-label`, `title`, `placeholder` and `document.title` —
the contexts that cannot hold an element. It isolates with **U+2068 FSI** and **U+2069 PDI**,
the Unicode controls `<bdi>` is defined in terms of. The hole is closed, not accepted.

### The dictionaries

`i18n/en.ts` is the source of truth and exports `Dict = Record<keyof typeof en, string>`;
`i18n/fa.ts` is declared `const fa: Dict`, so a missing or misspelled key is a **compile
error**. `tests/unit/i18n.test.ts` covers what the type cannot: identical key sets at runtime
(catching a `fa` built with `as Dict`), no empty values, nothing still equal to its English
string, and **the same parameter names in both templates** — a Persian template that dropped
`{count}` renders a sentence with a number missing, and no reviewer who does not read Persian
would catch it.

### Direction is set before first paint

`bootstrap.js` sets `documentElement.lang` and `dir`, not React. It is a blocking classic
script in `<head>` and the bundle is a module (always deferred), so it runs first — which is
what makes "no left-to-right flash on a Persian page" a structural property rather than a
race React can lose.

The locale it uses:

1. `Accept-Language`, parsed server-side (`utils/accept-language.ts`) — a *guess*, with no
   database read, because that route is unauthenticated;
2. overridden by `localStorage['panel.locale']` in the same script, which is where the
   client caches the stored choice after `GET /api/auth/me` returns it.

So the only wrong-direction frame anyone ever sees is on a brand-new browser profile whose
`Accept-Language` disagrees with the stored preference.

`users.locale` is nullable and **null is not `'en'`**: null means never chosen, so the guess
is still in force. `PATCH /api/settings/locale` needs a full session and no step-up, and is
the one write in the panel with no audit row.

### Logical properties only

`margin-inline-start`, not `margin-left`. `text-align: start`, not `left`.
`inset-inline-end`, not `right`. `border-inline-start`, not `border-left`.

Enforced by `tests/integration/client-discipline.test.ts`, which scans every `.ts`, `.tsx`,
`.css` and `.html` file under `src/client`, strips comments, and names the logical property
each finding should have used. The allowlist (`PHYSICAL_ALLOWED`) is currently **empty**;
anything added to it needs a sentence saying why the thing has a physical side.

### The left-to-right islands

`dir="ltr"` on the container, never on the page. Components: `<Ltr>`, `<Mono>`,
`<MonoBlock>` in `src/client/components/Ltr.tsx`.

The complete list of what must be an island:

> the terminal (Phase 3); any code or JSON editor (M2.4); file paths; the file browser's
> breadcrumb (M2.3); the base path; tokens, hashes, commit ids and recovery codes; the TOTP
> secret and its `otpauth://` URI; log output and audit metadata; **every memory, CPU and
> disk reading**; durations and byte counts; a user-agent string; a session or queue id.

### Numbers and dates

`src/client/lib/format.ts`. Two formatters, and the distinction is load-bearing:

| | Locale | For |
| :--- | :--- | :--- |
| `formatNumber`, `formatDate` | `fa-IR` / `en-GB` | prose quantities and dates |
| `formatTechnical`, `formatTechnicalDate`, `formatBytes`, `formatPercent`, `formatDuration` | `fa-IR-u-ca-persian-nu-latn` | everything in an LTR island |

**Latin digits for every technical value in both languages.** `fa` defaults to `arabext`
numbering, so `Intl.NumberFormat('fa-IR').format(8080)` is `۸۰۸۰`: a port that does not match
the terminal, a byte count that will not `grep`, a commit id that is not the commit id.
`-nu-latn` is what keeps a number the same number on both sides of a clipboard. The Jalali
**calendar** is kept (`-ca-persian`), because a date is read rather than pasted.

**Bytes are decimal.** 1 GB is 1 000 000 000, not 1 073 741 824. Railway quotes the plan in
GB, and rendering a 1 GB limit as "0.93 GiB" tells the operator their plan is smaller than
they bought.

### Fonts

Vazirmatn (SIL OFL 1.1) for both scripts and JetBrains Mono (SIL OFL 1.1) for code, as
`@fontsource`'s per-script subsets split by `unicode-range` — so an English-only page fetches
16 KB of Latin and never the 21 KB of Arabic.

**Committed, not downloaded at build time.** The Dockerfile deliberately removes network
dependencies from the image build (it has already failed twice on transient network errors),
and the runtime image has no Python to subset with. `scripts/fonts.mjs` reproduces the files
and pins each by SHA-256; `npm run fonts` verifies what is on disk.

**No Inter**, departing from `PLAN.md`. Every technical value in this panel is Latin sitting
*inside* a Persian sentence, so the two scripts meet on nearly every line; Vazirmatn's own
Latin companion is designed against its Arabic metrics and Inter is not. Shipping both would
mean one font that never renders a glyph — dead weight in the image and a second licence to
track.

The licences are copied into `dist/client/` by `scripts/copy-assets.mjs`, which is why that
script now runs **after** `vite build` (`emptyOutDir` would otherwise delete them).

---

## 5. The API layer

`src/client/lib/api.ts` is the only place in the client that speaks HTTP.

- prefixes `window.__BASE__`; nothing else builds a URL;
- reads the CSRF cookie **by the name the server gave** (`window.__CSRF_COOKIE__`). It is
  `__Secure-panel_csrf` over https and `panel_csrf` over loopback http, and
  `plugins/cookies.ts` is the only file allowed to decide which — a hard-coded name works on
  one deployment and 403s on every mutation on the other, with a correct-looking cookie in
  the jar and nothing in the console;
- `credentials: 'same-origin'` explicitly, and `redirect: 'error'`;
- **never logs a request or response body.** The bodies here include a password, a TOTP
  secret, ten recovery codes and a revealed credential;
- on **401** drops to the sign-in screen (`onUnauthenticated`);
- on **403 `step_up_required`** raises the step-up prompt and retries the original request
  **exactly once**. Once, and only for that code: a loop traps an operator who keeps
  cancelling, and retrying a CSRF failure would fail identically;
- on **429** surfaces `Retry-After` as a wait rather than a failure, and distinguishes
  `auth_in_progress` from `rate_limited` — the first means *your other tab is mid-login*.

### The error-code enum

Declared in `src/shared/types.ts` as `ErrorCode`, with `ERROR_CODES` and `isErrorCode()` as
its runtime form. `app.setErrorHandler` sends `{error, code}` and nothing else.

| Code | Status | Meaning |
| :--- | :--- | :--- |
| `unauthenticated` | 401 | no live session, or the wrong level |
| `bad_credentials` | 401 | **every** authentication rejection |
| `step_up_required` | 403 | a full session that has not stepped up |
| `csrf_invalid` | 403 | the double-submit token |
| `forbidden` | 403 | `Origin`/`Host`, or any other refusal |
| `rate_limited` | 429 | an empty token bucket; honour `Retry-After` |
| `auth_in_progress` | 429 | the single-flight gate |
| `weak_password` | 400 | |
| `bad_request` | 400 | |
| `not_found` | 404 | |
| `conflict` | 409 | the panel's state does not permit it |
| `too_large` | 413 | |
| `server_error` | 5xx | the reason is in the log, not here |

Two properties, asserted in `tests/integration/error-codes.test.ts`:

- **The set is closed at runtime.** `isErrorCode` gates what reaches a body, and it is not a
  formality: Fastify's own errors carry a `code`, so a body over `bodyLimit` arrives at the
  handler with `FST_ERR_CTP_BODY_TOO_LARGE` on it. Forwarding it unchecked would put a
  library identifier into a response body — the same shape as the two credential leaks that
  came out of error *messages*.
- **A code discloses nothing the status does not.** Every authentication rejection is
  `bad_credentials`: unknown username, wrong password, wrong code, *replayed* code, spent
  recovery code. The audit log keeps the categories; the client does not get them, because
  "that code was valid and already used" is a fact about the panel's state.

### Routing

Hand-written, `src/client/lib/router.tsx`, ~120 lines including the comments. Five routes;
React Router's two features this panel would use are a `basename` and a catch-all, and the
rest is dependency surface inside the container that holds `PANEL_MASTER_KEY`.

The base path is stripped on the way in and added on the way out, **in that file only** —
the same rule `lib/api.ts` follows for requests. A component that knew the prefix could leak
it into a link, a title, or a log line.

---

## 6. The poll budget

`GET /api/metrics`, from `src/client/pages/Overview.tsx`:

| Tab state | Cadence | Requests/min |
| :--- | :--- | :--- |
| visible | 2 s | 30 |
| hidden | 30 s | 2 |
| closed | — | 0 |

The session bucket holds 120 tokens and refills 240 a minute, so a visible tab uses an eighth
of the refill and never touches the capacity; three tabs at two seconds is still inside it.

The 30 s hidden cadence is **above the sampler's own 1000 ms cadence and below its 60 s idle
timeout**, deliberately: a hidden tab keeps the sampler warm, so `cpu.percentOfQuota` stays a
number instead of resetting to `null` on every poll.

It is a `setTimeout` chain rather than a `setInterval`, so a slow response cannot queue a
second request behind the first — which is how a widget on a struggling panel becomes the
reason it is struggling. A 429 is swallowed rather than shown: the next poll is two seconds
away and the bucket refills at four a second.

**Do not exceed this budget.** M2.7 inherits it.

---

## 7. Runtime dependencies

The panel had **zero** client dependencies before this milestone. This is the floor for every
one that follows, and every one of them lands inside the container that holds
`PANEL_MASTER_KEY`.

| Package | Licence | Installed | Replaces | Why not hand-written |
| :--- | :--- | :--- | :--- | :--- |
| `react` 19.2.8 | MIT | 260 KB | — | A hand-rolled renderer is a framework with one user and no ecosystem. The panel has forms with real state (a login that can take 30 s, a five-minute countdown, a step-up that suspends a request mid-flight) and a poll loop that must not tear. |
| `react-dom` 19.2.8 | MIT | 7.2 MB on disk | — | Ships with `react`; the disk figure is dev + prod + profiling builds. |
| `scheduler` 0.27.0 | MIT | 128 KB | — | `react-dom`'s only transitive dependency. |

**In `dependencies`, not `devDependencies`, deliberately.** The bundle ships to the browser,
and `npm audit --omit=dev` is a build gate in this project (CLAUDE.md) — so the audit has to
be able to see the code the operator actually runs. The cost is that the runtime image also
carries the packages; the alternative is an advisory in `react-dom` that the gate cannot see.

Build-time only, in `devDependencies`: `vite` 6.4.3, `@vitejs/plugin-react` 4.7.0,
`@types/react`, `@types/react-dom`, and the two eslint react plugins. None reaches the
runtime image (`npm prune --omit=dev`).

**Declined, with reasons:**

| Not taken | Instead | Why |
| :--- | :--- | :--- |
| a router (React Router, wouter, …) | 120 lines in `lib/router.tsx` | five routes; the two features needed are a basename and a catch-all |
| any CSS-in-JS | plain CSS with custom properties | unusable under `style-src 'self'` with no nonce and no SSR; a static scan forbids the package names |
| Tailwind v4 | plain CSS | the logical-property scan is exact over CSS and unsound over `className` strings; and a native binary in the builder |
| a QR renderer | the `otpauth://` URI and the secret in a copyable block | ~50 KB to save typing 32 base32 characters once per install |
| a date library | `Intl.DateTimeFormat` with `-ca-persian` | the platform gives a Jalali calendar with no library |
| an icon set | text and one emoji-free glyph budget | every icon is an image request or an inline SVG to audit |

**Removed in this milestone:** `qrcode` (a runtime dependency nothing imported),
`tailwindcss` and `@tailwindcss/vite` (unused, native binary), `supertest` and
`@types/supertest` (unused, and the only source of the one moderate advisory in the tree).
`npm audit` reports **0 vulnerabilities** with and without `--omit=dev`.

---

## 8. Accessibility

Not a pass at the end; the properties a mouse never exercises:

- **Keyboard.** Every action is a `<button>` or an `<a href>`. The skip link is the first
  focusable element and is off-screen rather than `display: none` — which would take it out
  of the tab order and defeat it.
- **Focus.** `:focus-visible` with a two-colour outline, so a mouse click draws no ring and
  Tab always does. `<main>` carries `tabIndex={-1}` so the skip link and every navigation can
  move focus into it.
- **Labels.** Every input has a real `<label for>` with a required, stable id — a generated
  id is one more thing that can differ between two renders and break the association
  silently.
- **Announcements.** The slow login path is `role="status"` (`aria-live="polite"`), not
  `alert`: up to thirty seconds of expected waiting must not interrupt a screen reader
  mid-sentence, while an error is `role="alert"`. A busy button carries `aria-busy`.
- **Colour is never the only signal.** Every notice and badge carries words as well as a
  colour.
- **The gauge** is `role="meter"` with `aria-valuenow`/`min`/`max` and a label, because a bar
  says nothing to a screen reader.
- **Navigation** marks the current item with `aria-current="page"`, which is announced;
  colour alone is not.
- **The dialog** is the platform's `<dialog>` with `showModal()`, so the focus trap, the
  inert background, the backdrop and Escape are the browser's rather than hand-rolled. A
  one-time disclosure (recovery codes, a new base path) sets `dismissable={false}` and
  refuses Escape, because a stray keypress must not be how ten codes are lost.

Lighthouse is the operator's check — see `docs/SECURITY.md` §*Manual Browser Checks*.
