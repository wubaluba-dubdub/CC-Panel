# The client — tokens, constraints, and the rules that are enforced

The interface built in M2.1 and repaired in M2.1.1: what it is made of, what the Content
Security Policy forbids, and where each rule is enforced rather than merely written down. Read
this before adding a component, a dependency, or a stylesheet.

**§7 is the gate.** It lists every rule in this document beside the file that fails when the
rule is broken. If you are here to add a component, read §5, §6 and §7.

`docs/SECURITY.md` is the authority for the header set and the manual browser checks;
`PLAN.md` §*M2.1* is the authority for the milestone's scope. This document is the
authority for how the client is built.

---

## 1. Design tokens

**`src/client/styles/tokens.css` is the only file in the client that may contain a literal
value or define a custom property.** Everything else references them with `var()`.
`tests/integration/client-style.test.ts` scans every other `.css`, `.ts` and `.tsx` file and
fails on a colour literal, a raw duration, an easing curve or a raw `px` length. The single
exception the scan permits is a `px` length inside an `@media` condition, which is evaluated
before custom properties are substituted — `@media (max-width: var(--x))` works in no engine.

### Colour

| | Value | For |
| :--- | :--- | :--- |
| `--bg` | `#0a0a0b` | the page |
| `--surface` | `#131316` | a card, the navigation, a sticky header |
| `--surface-raised` | `#1b1b1f` | an input, a code block, a detail row |
| `--surface-hover` | `#212127` | under the pointer: a row, a default button |
| `--hairline` / `--hairline-strong` | `#26262b` / `#34343b` | borders; there are two, not five |
| `--ink-primary` | `#e8e8ea` | a value the operator reads: a cell, a heading, body text |
| `--ink-secondary` | `#9a9aa2` | prose that supports a value: a lede, a card's explanation, a field label, a badge |
| `--ink-tertiary` | `#6b6b73` | text about the interface rather than about the data: a column header, a footnote, a field hint, a sub-line |
| `--accent` / `--accent-bright` / `--accent-dim` / `--accent-ink` | `#6e8bff` / `#8a9fff` / `#2b3a7a` / `#0a0a0b` | **one** accent, its hover, its dim edge, the ink on it |
| `--danger` / `--warn` / `--ok` | `#ff6b6b` / `#ffb95c` / `#57d9a3` | status, and never the accent |
| `--highlight` | `rgb(255 255 255 / 6%)` | the one-pixel inner top highlight on a card |
| `--backdrop` | `rgb(0 0 0 / 60%)` | behind a modal |
| `--scrollbar-thumb` / `--scrollbar-track` | `#3d3d45` / `#17171a` | so a scroll container in a dark card shows no bright platform bar |

Three rules about colour:

- **Three surfaces and no more** (plus one hover tint, which nothing is drawn *on*). A dark
  interface with six greys reads as noise, and every extra step is a decision to make at every
  component.
- **The ink tones are named for their role, not for how dim they are.** They used to be
  `--text`, `--text-muted`, `--text-faint` — three deliberate tokens, but named for a question
  with no answer at the point of use, which is how the sessions screen ended up using one value
  for the column headers, a sub-line and a footnote for three unrelated reasons and reading as
  three ad-hoc greys. The table above is the rule; use it.
- **Status colours are not brand colours.** A red that is also the accent makes every button
  look like a warning.
- **`--accent-bright` is a literal, not a `color-mix()` of the accent.** An unsupported
  `color-mix` is an invalid value, and an invalid `background` on the primary button is a
  *transparent* button rather than a slightly wrong colour.

### Space, radius and measure

| | Value | Note |
| :--- | :--- | :--- |
| `--s1`…`--s7` | 4, 8, 16, 24, 32, 48, 64 px | the 8px grid; every gap, pad and margin is one of these |
| `--radius-sm` / `--radius` / `--radius-lg` / `--radius-pill` | 4 / 8 / 12 / 999 px | one radius per element class: `sm` for a chip-sized affordance, the default for a control, `lg` for a card or dialog, `pill` for a badge or a gauge |
| `--border-w` / `--rule-w` | 1 / 3 px | a hairline, and a notice's edge |
| `--focus-w` / `--focus-offset` | 2 / 2 px | the focus ring, which never animates |
| `--measure-prose` / `--measure-wide` | 76ch / 132ch | see below |
| `--measure-auth` / `--measure-dialog` / `--measure-boot` | 44ch / 52ch / 60ch | the sign-in card, a modal, the diagnostic page |
| `--side-w` | 220px | the navigation column |
| `--table-max-block` | 70vh | how tall a table gets before it scrolls inside its card |
| `--gauge-h` / `--chevron` | 8 / 5 px | |
| `--offscreen` | -9999px | where the skip link parks |

### The two measures

`.main` may grow to `--measure-wide`, and **every direct child of the routed region is clamped
back to `--measure-prose`**. So every screen is laid out exactly as it was, except a card that
opts into `card-wide` — which is the card holding a data table.

The reason is that prose and a table want different widths for the same reason: 76 characters is
a reading measure, and four timestamp columns plus a client column is not reading. Clamped to
the prose measure, the sessions table scrolled horizontally on a 1920px display for a reason
that had nothing to do with the display.

### Type

| | Value |
| :--- | :--- |
| `--font-ui` | Vazirmatn, Inter, system-ui, … |
| `--font-mono` | 'JetBrains Mono', ui-monospace, … |
| `--text-xs`…`--text-2xl` | 12, 13, 14, 17, 22, 28 px |

### Motion

| | Value | For |
| :--- | :--- | :--- |
| `--t-press` | 90ms | the scale on `:active` |
| `--t-fast` | 120ms | a colour change under the pointer |
| `--t-standard` | 160ms | something entering: a screen, a detail row, a dialog |
| `--t-slow` | 220ms | the gauge — a bar showing a rate should not arrive faster than the rate changes |
| `--t-pulse` | 1400ms | the skeleton's pulse |
| `--t-none` | 0s | an explicit de-animation |
| `--ease` | `cubic-bezier(0.32, 0.72, 0, 1)` | |
| `--skeleton-low` / `-mid` / `-high` | 0.3 / 0.5 / 0.7 | the pulse's ends, and where it rests under reduced motion |
| `--enter-shift` | 4px | how far a screen travels on entering |

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
| `img-src 'self' data:` | A `data:` image *would* be allowed. It is still not used, and `tests/integration/build.test.ts` asserts that the emitted stylesheet contains no `data:` URL and that every `url()` in it is relative — one rule, which also keeps a font from being inlined. The select's chevron is a CSS triangle for that reason. |
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
@property --gauge-fill { syntax: '<percentage>'; inherits: false; initial-value: 0%; }
.gauge-bar { inline-size: var(--gauge-fill); }               /* globals.css */
```

No `style` attribute exists in the markup at any point. `tests/integration/client-discipline.test.ts`
forbids a `style` prop anywhere in `src/client`.

The `@property` registration is not decoration — see §6: without it the value has no type, CSS
interpolates it discretely, and the transition that makes the bar move is a silent no-op.

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
each finding should have used.

M2.1.1 extended it to the physical **axis** names — `width`, `height`, `min/max-*`,
`overflow-x`, `overflow-y` — which are a different case from a physical *side*: an axis is
symmetric under a direction change, so the name carries no direction assumption. That is why
they get an allowlist with a reason rather than a ban. `PHYSICAL_ALLOWED` has exactly two
entries, both in `globals.css`: `overflow-x` on the scroll region and on `.main`, and `width`
on a `<col>`. Each carries its sentence in the map itself, keyed `<file>:<property>` so an
exemption cannot silently widen to a whole file.

One structural exception, not an allowlisted one: a `px` length or a `width` inside an `@media`
condition. Media queries are evaluated before custom properties are substituted and have no
logical spelling at all — `@media (inline-size: …)` is a container query, not a media query.

### The left-to-right islands

`dir="ltr"` on the container, never on the page. Components: `<Ltr>`, `<Mono>`,
`<MonoBlock>` in `src/client/components/Ltr.tsx`.

The complete list of what must be an island:

> the terminal (Phase 3); any code or JSON editor (M2.4); file paths; the file browser's
> breadcrumb (M2.3); the base path; tokens, hashes, commit ids and recovery codes; the TOTP
> secret and its `otpauth://` URI; log output and audit metadata; **every memory, CPU and
> disk reading**; durations and byte counts; a user-agent string; a session or queue id.

### Numbers and dates

`src/client/lib/format.ts`. Two number formatters, and the distinction is load-bearing:

| | Locale | For |
| :--- | :--- | :--- |
| `formatNumber` | `fa-IR` / `en-GB` | a quantity inside a sentence |
| `formatTechnical`, `formatBytes`, `formatPercent`, `formatDuration`, `formatInstant` | `fa-IR-u-ca-persian-nu-latn` | everything in an LTR island |

**Latin digits for every technical value in both languages.** `fa` defaults to `arabext`
numbering, so `Intl.NumberFormat('fa-IR').format(8080)` is `۸۰۸۰`: a port that does not match
the terminal, a byte count that will not `grep`, a commit id that is not the commit id.
`-nu-latn` is what keeps a number the same number on both sides of a clipboard. The Jalali
**calendar** is kept (`-ca-persian`), because a date is read rather than pasted.

**Bytes are decimal.** 1 GB is 1 000 000 000, not 1 073 741 824. Railway quotes the plan in
GB, and rendering a 1 GB limit as "0.93 GiB" tells the operator their plan is smaller than
they bought.

**One instant formatter, and it is the only `Intl.DateTimeFormat` in the client** — a scan says
so, because a second construction site is how a second date format appears on a second screen.
Three decisions in it:

- **A month token, never a numeric month.** `dateStyle: 'short'` renders 5 September 2026 as
  `05/09/2026`, which is 5 May to a US reader, and the screen this was reported from showed
  `05/09/2026` and `05/10/2026` together, where the ambiguity is *worse* rather than better
  because either reading is internally consistent. `5 Sept 2026, 23:24` and
  `14 شهریور 1405، 23:24` cannot be misread.
- **Two precisions and no others.** Minutes everywhere; seconds only in the audit log, where the
  order of two rows inside one minute is information. A hard expiry thirty days away does not
  carry a meaningful second, and showing one invites the reader to trust it.
- **The exact instant is one hover away**, in a `title` carrying the local time with its UTC
  offset and the same instant in UTC — because the panel's log lines and Railway's are in UTC,
  and a timestamp that cannot be converted cannot be used as evidence. It is an attribute, so it
  goes through `ts()`.

The formatters are memoised per locale and precision, and `tests/unit/format.test.ts` asserts
the construction count: four are possible, and a hundred audit rows used to build a hundred.

**Every number and every timestamp is in the mono face**, through `<Time>`, `<Mono>` or
`<MonoBlock>` — which makes the tabular-figures question moot by construction, because a
monospaced face has one advance per glyph and a polled value cannot change width as its digits
change.

That is a measurement rather than a preference. `font-variant-numeric: tabular-nums` was the
alternative, and the feature tables in the shipped subsets are:

| Subset | OpenType features present |
| :--- | :--- |
| `vazirmatn-latin-400` | `kern, liga, lnum, pnum, zero` — **no `tnum`** |
| `jetbrains-mono-latin-400` | `calt, liga` (a monospaced face needs no `tnum`) |
| `vazirmatn-arabic-400` | `kern, calt, liga, tnum` — but that subset covers Persian script, not the Latin digits the panel renders |

So `tabular-nums` on the UI face would have been a **silent no-op on exactly the values it was
there to protect**. Nothing in the panel relies on it.

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

## 5. The primitives: a card, a scroll region, a table

M2.1.1 exists because two of these leaked. The rules below are what a screen may assume, and
each one is enforced.

### Containment: a container owns its edges

**Nothing drawn inside a card may cross its border, its radius, its padding box or its
background.** `.card` is a clipping context and anything that can be wider than the card sits in
a `<ScrollRegion>` inside it: the card clips, the region scrolls.

That is the root cause of the whole family of defects this milestone repaired. Both tables were
laid out by `table-layout: auto`, so a table's width was the sum of its widest cells — a raw
`User-Agent` string and a JSON blob — and nothing clipped or scrolled. The result was drawn
*through* the card: the sessions list's last column header and every row's divider across the
border and its rounded corner, and about 350 pixels of audit metadata sitting on the page.

`overflow: clip`, with `overflow: hidden` on the line before it as the fallback for an engine
that does not parse `clip`. The order matters and is not cosmetic: `hidden` makes the box a
scroll *container*, so a card with one clipped pixel becomes something the operator can nudge
sideways with no scrollbar to say so, and a focus move can scroll it. `clip` clips and cannot
scroll.

### Every overlay is in the top layer

The consequence of a clipping card, and the rule M2.2's command palette needs: **anything that
must escape a card cannot be a positioned descendant of one.** Every overlay in this panel is a
real `<dialog>` opened with `showModal()`, which the browser promotes to the *top layer* —
outside every clipping context, stacking context and `overflow` on the page.

`tests/integration/client-style.test.ts` forbids `position: fixed` anywhere in the client CSS,
allows `position: absolute` only for four named selectors, and fails if any file other than
`components/ui.tsx` renders a `<dialog>` or names an overlay-shaped class. A palette clipped by
a card is exactly the defect that scan exists to stop repeating.

### The scroll region

`<ScrollRegion>` in `components/ui.tsx`: `overflow-x: auto`, a maximum block size of
`--table-max-block`, `scrollbar-gutter: stable` so nothing shifts when a bar appears, and a thin
scrollbar in the panel's own colours.

`overflow-x`, not `overflow-inline`, and it is in the logical-property scan's allowlist with this
reason: a horizontal axis is **symmetric under a direction change** — an RTL document scrolls the
same box the other way with no rule change — so the physical axis name carries no direction
assumption at all. `overflow-inline` is the logical spelling and is too recent to make a
browser's release date a requirement of this panel.

It is `role="region"` with a name, and carries **no `tabindex`**. Chrome 127 and later make a
scroll container focusable by itself, but only when it has no focusable descendant; Firefox and
Safari do not do it at all. Every row in both tables has a focusable control, so an explicit
`tabindex="0"` would add a stop that Chrome already provides where it is useful, and a *dead*
one in the common case where the table is not overflowing. Tab reaches the region's contents
through the rows, and the browser scrolls a focused cell into view — which is how a keyboard
user reaches a column that is off the edge. **Reasoned from the specification and not verified
in a browser**; `docs/SECURITY.md` item 33 is the verification.

### The table

`components/Table.tsx` is the only file in the client that renders a `<table>`, and a scan says
so. `DataTable` for a grid, `KeyValueTable` for a label-and-value report — whose first column is
a column of `<th scope="row">`, which is what tells a screen reader the value belongs to the
word beside it.

Every table has:

- **`table-layout: fixed` with a complete `<colgroup>`.** A fixed layout divides the remaining
  width equally between the columns that declare none, so a *partial* colgroup is worse than an
  automatic layout, not better.
- **One definition, in `lib/table.ts`.** The colgroup, the header row and each row's cells all
  come from the same array; a row supplies its cells as a `Record` keyed on the column keys, so a
  missing cell is a **compile error**. That is the strongest available form of "the colgroup
  declares as many columns as the header row has cells" — the two cannot disagree, because there
  is one array.
- **A character budget per column, asserted in both languages.** `tests/unit/client-tables.test.ts`
  checks every header and every enumerated cell label against its column's budget in `en` *and*
  `fa`, minus the cell padding. The reported defect was the "This device" pill broken onto two
  lines inside its own border, and the reviewer of the Persian dictionary does not read Persian.
  A pill never wraps (`white-space: nowrap`); the scroll region absorbs what a budget cannot.
- **`min-inline-size` equal to the sum of its columns.** Without it a browser scales the declared
  widths down to fit, so the budgets would hold only when there was room — which is exactly when
  they do not matter. The test asserts the sum against the definition.
- **A visually hidden `<caption>`** as the accessible name, and the same string names the scroll
  region.
- **A sticky header**, painted with the card's own surface so rows scroll under it. It needs the
  region's maximum height to mean anything: a region that never scrolls vertically has no
  scrollport, and `position: sticky` on its header would be a no-op.
- **One row expander.** A button carrying `aria-expanded`, and a detail row spanning every column
  that is mounted only while open — so `aria-controls` never names an element that is not there.
  It reveals with **opacity**. Not with height: a height transition on a table row is a reflow per
  frame, which §6's allowlist forbids.

`width` on a `<col>` is the one physical sizing property in the stylesheet, and it is in the
scan's allowlist: a column's used width is what the fixed layout algorithm reads (CSS 2.1
§17.5.2.1 names that property), the axis is symmetric under a direction change, and a column that
silently failed to take its width would divide the table into equal parts — the exact defect the
fixed layout was adopted to fix.

### Unbounded data is summarised, never rendered raw

Two columns held values the panel does not author, and both are now summaries with the raw value
behind the expander.

**The client string.** `lib/user-agent.ts` reduces a `User-Agent` header to three facts:
a browser and a platform from two closed enumerations, plus a major version of at most four
digits. The input is capped at 256 characters *before* a single pattern runs over it. The
property that matters is not that it recognises Chrome — it is that **no substring of the header
reaches the screen through it**, which is a stronger statement than "React escapes it" and is
what makes the summary safe to put inside a translated sentence. The connecting word comes from
the dictionaries; the two names do not, because a browser is called Chrome in Persian too.
Tested against the empty string, 4 KB, right-to-left controls, a script tag, and a string that
claims to be three browsers at once.

**Audit metadata.** `lib/meta.ts` renders it as capped key/value pairs, three inline and the rest
behind the expander with the exact stored JSON and a copy control. The keys stay **untranslated**
for the same reason the event names do: they are grep keys, and the `sessionId` on this screen has
to be the `sessionId` in a Telegram message and in a Railway log line. Values are capped by code
point, so a truncation cannot leave half a character on the screen.

### The select

The audit filter is a **native `<select>`** and will stay one: the keyboard behaviour, the
screen-reader behaviour and the platform's own popup are what a hand-built listbox has to
re-implement, and it gets one of them wrong.

What is styled is the *closed* control — border, radius, focus ring, and a chevron drawn as a CSS
triangle on the wrapper. Its width is `auto` with a maximum, because the two defaults are both
wrong: `100%` made a six-word filter 620 pixels wide next to controls sized by their content.

**An `<option>` cannot be styled meaningfully.** The popup is drawn by the operating system in
every engine, so a colour set on an option is honoured on one platform and ignored on the next.
Written down here to save the afternoon.

The chevron is a CSS triangle rather than a `data:` SVG, which `img-src 'self' data:` would
permit: `tests/integration/build.test.ts` asserts that the emitted stylesheet contains **no**
`data:` URL and that every `url()` in it is relative — the rule that keeps a font from being
inlined. A triangle needs no exception to either.

---

## 6. Motion

The operator asked for soft animation on a panel that was correct and completely static. What
makes that safe here rather than merely pretty is three rules, each of them a scan in
`tests/integration/client-style.test.ts`.

**Everything is inside `@media (prefers-reduced-motion: no-preference)`.** Every transition,
every animation and every `@keyframes` rule, in one §*Motion* block at the foot of
`globals.css`. The one exception the scan permits is a *de*-animation — a zero duration or
`none` — which is how the gauge's transition is switched off explicitly under `reduce` rather
than merely left out.

**A closed allowlist of animatable properties.**

| Animatable | Why |
| :--- | :--- |
| `opacity` | composited; no layout, no paint invalidation |
| `transform` | composited; the press scale, the chevron, the screen enter |
| `--gauge-fill` | registered with `@property`, so it interpolates |
| `background-color` | a paint: a hovered row, a hovered button |
| `border-color` | a paint: a hovered control |
| `color` | a paint: a hovered link, the expander |
| `display`, `overlay` | **only with `allow-discrete`**; neither interpolates, and that is the point |

Nothing else — no `height`, no `inline-size`, no `inset`, no `margin`, no `padding`, no
`background-position`, no `filter`. The reason is this panel specifically: **it polls every two
seconds**, so a layout-animating property is a reflow per frame while data is arriving and the
operator is reading numbers.

**A state is not an animation.** Where a hovered button's colour lands, and which way the
chevron points, are *outside* the guard; only the travel between two states is inside it. So
reduced motion removes the travel and never the information. The focus ring is not animated at
any duration under any preference: it has to be on screen on the frame the element takes focus.

### The gauge, and the registration that makes it work at all

```css
@property --gauge-fill { syntax: '<percentage>'; inherits: false; initial-value: 0%; }
```

An **unregistered** custom property has no type, so CSS interpolates it *discretely*: the
transition applies, does nothing visible, and looks exactly like an animation nobody added. That
is why the bar stepped between polls. The suite asserts the registration block, because its
absence is invisible.

### No polled value may appear in a key

The routed region is `<div className="screen" key={route.name}>` and its enter animation runs on
mount. **A key carrying a polled value would remount the subtree every two seconds and replay
the animation while the operator was reading it** — which would make this section the one place
in the milestone that could leave the panel worse than static. The scan asserts that line and
that no `key={…}` in the client names a polled value.

For the same reason **nothing animates on a poll tick**: the metrics figures, the audit rows and
the session cells change in place. Only a first mount animates.

### The dialog, both ways

`@starting-style` supplies the from-state for the enter, because there is none — the element was
`display: none`. The exit transitions `display` **and `overlay`** with `allow-discrete`: without
the second one the element leaves the top layer on the first frame and the rest of the animation
plays behind the page. Where `@starting-style` is unsupported the dialog appears instantly; that
is an acceptable degradation, written down rather than shimmed with JavaScript.

### The skeleton

A block at `--skeleton-mid` that pulses between `--skeleton-low` and `--skeleton-high` over
`--t-pulse`, and rests exactly at the midpoint under reduced motion. **No travelling gradient**:
that animates `background-position`, which the allowlist forbids.

### Deferred, with reasons

| Not built | Why |
| :--- | :--- |
| relative time ("3 minutes ago") | a relative label that does not tick is worse than an absolute one, and a ticking label is a second timer to get wrong on a panel that already polls. Revisit when something needs it. |
| a stacked card layout per row on a narrow viewport | turning a table into cards means `display: block` on table elements, which discards the row and column semantics that make these two screens readable with a screen reader. The correct fix is *different markup per breakpoint*, which is its own decision; the scroll region makes a narrow viewport usable in the meantime. |
| view transitions | attractive here, and a second rendering path to reason about on a panel whose perimeter is exact. A deferral rather than an omission. |

---

## 7. The gate: every rule, and the scan that enforces it

A rule that holds on the first component and not on the fortieth is not a rule. Each line below
names the file that fails when the rule is broken, so a future session can find the enforcement
and not only the prose.

| Rule | Enforced by |
| :--- | :--- |
| logical properties only — `margin-inline-start`, `text-align: start`, `inset-inline-end` | `tests/integration/client-discipline.test.ts` |
| physical *axis* names (`width`, `height`, `overflow-x`) only where the axis is symmetric under a direction change, each with a reason | the same file's `PHYSICAL_ALLOWED` map, keyed `<file>:<property>` |
| no runtime CSS-in-JS, as a dependency or as an import | `tests/integration/client-discipline.test.ts` |
| no `style` prop, no `style` attribute, no `style.cssText`, no `setAttribute('style')`, no `dangerouslySetInnerHTML` | `tests/integration/client-discipline.test.ts` |
| the client imports nothing from `src/server` and nothing from `node:` | `tests/integration/client-discipline.test.ts` |
| one token file: no colour, duration, easing curve or raw `px` outside `styles/tokens.css`, in CSS or in TypeScript | `tests/integration/client-style.test.ts` |
| every custom property is defined in `styles/tokens.css` | `tests/integration/client-style.test.ts` |
| a card clips; the region inside it scrolls, with a stable gutter and a thin themed bar | `tests/integration/client-style.test.ts` |
| every overlay is a `<dialog>` in the top layer; nothing is `position: fixed`; `position: absolute` only for four named selectors | `tests/integration/client-style.test.ts` |
| only `components/Table.tsx` renders a `<table>`, `<colgroup>`, `<caption>` or `<thead>` | `tests/integration/client-style.test.ts` |
| the colgroup, the header row and the cells all come from one array | the same file, plus the compiler: a row's `cells` is a `Record` keyed on the column keys |
| every column has a size, every size has a CSS rule with the same number, every table's `min-inline-size` is the sum of its columns | `tests/unit/client-tables.test.ts` |
| every header and enumerated cell label fits its column's character budget **in both languages** | `tests/unit/client-tables.test.ts` |
| the scroll region has a name and no `tabindex` | `tests/integration/client-style.test.ts` |
| one `Intl.DateTimeFormat` construction site; every timestamp goes through `<Time>` | `tests/integration/client-style.test.ts` |
| the instant formatter is memoised per locale and precision | `tests/unit/format.test.ts` asserts the construction count |
| no rendered date can be read as two different days; two precisions only | `tests/unit/format.test.ts` |
| the user-agent summariser returns closed-set members for hostile input, and caps before matching | `tests/unit/user-agent.test.ts` |
| every metadata value is capped, by code point; the raw form is the stored form | `tests/unit/audit-meta.test.ts` |
| every transition, animation and `@keyframes` rule is inside the reduced-motion guard | `tests/integration/client-style.test.ts` |
| only the allowlisted properties are animated, and `display`/`overlay` only with `allow-discrete` | `tests/integration/client-style.test.ts` |
| `--gauge-fill` is registered with `@property`, and its transition is switched off explicitly under `reduce` | `tests/integration/client-style.test.ts` |
| the routed region is keyed by the route, and no `key={…}` names a polled value | `tests/integration/client-style.test.ts` |
| the built shell carries no inline script, no inline style, no `style` attribute, no `data:` URL, and every `url()` in the CSS is relative | `tests/integration/build.test.ts` |
| the base-path sentinel is in the file on disk and gone from every served body | `tests/integration/build.test.ts`, `tests/integration/base-path.test.ts` |
| both dictionaries cover the same keys, name the same parameters, and share no untranslated value | `tests/unit/i18n.test.ts` |

Two things no scan can reach, and both are the operator's:

- **What a browser does with the bytes.** No test here evaluates a CSP, executes a script, or
  lays anything out. `docs/SECURITY.md` §*Manual Browser Checks* is the list, ordered by what
  would be most damaging to discover late, and every layout item has a right-to-left mirror.
- **Whether it looks right.** A budget that fits is not a column that reads well.

---

## 8. The API layer

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

## 9. The poll budget

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

## 10. Runtime dependencies

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

## 11. Accessibility

Not a pass at the end; the properties a mouse never exercises:

- **Keyboard.** Every action is a `<button>` or an `<a href>`. The skip link is the first
  focusable element and is off-screen rather than `display: none` — which would take it out
  of the tab order and defeat it.
- **Focus.** `:focus-visible` with an accent-tinted ring, so a mouse click draws no ring and Tab
  always does, and it is **not animated at any duration under any preference**: it has to be on
  screen on the frame the element takes focus. `<main>` carries `tabIndex={-1}` so the skip link
  and every navigation can move focus into it.
- **Labels.** Every input has a real `<label for>` with a required, stable id — a generated
  id is one more thing that can differ between two renders and break the association
  silently.
- **Announcements.** The slow login path is `role="status"` (`aria-live="polite"`), not
  `alert`: up to thirty seconds of expected waiting must not interrupt a screen reader
  mid-sentence, while an error is `role="alert"`. A busy button carries `aria-busy`. A loading
  table's skeleton carries a visually hidden `role="status"`, so the pulse is not the only signal.
- **Colour is never the only signal.** Every notice and badge carries words as well as a
  colour.
- **Tables.** A visually hidden `<caption>` names each one; the header cells are `<th scope="col">`
  and a key/value report's labels are `<th scope="row">`, which is what associates a value with
  the word beside it. The scroll region around each is a named `role="region"` — and carries no
  `tabindex`, for the reason in §5.
- **The row expander** is a `<button>` with `aria-expanded`, and `aria-controls` only while the
  detail row it names is mounted. Its chevron is decorative (`aria-hidden`); the word beside it is
  visually hidden and changes with the state.
- **The gauge** is `role="meter"` with `aria-valuenow`/`min`/`max` and a label, because a bar
  says nothing to a screen reader.
- **Every timestamp** is a `<time dateTime>` carrying the exact instant in its `title`, so the
  value is both machine-readable and correlatable with a log line.
- **Navigation** marks the current item with `aria-current="page"`, which is announced;
  colour alone is not.
- **The dialog** is the platform's `<dialog>` with `showModal()`, so the focus trap, the
  inert background, the backdrop and Escape are the browser's rather than hand-rolled — and the
  top layer, which is what keeps it out of every clipping context on the page. A one-time
  disclosure (recovery codes, a new base path) sets `dismissable={false}` and refuses Escape,
  because a stray keypress must not be how ten codes are lost.
- **Reduced motion** removes every transition and animation, and never removes information: a
  state is above the guard and only the travel between two states is inside it.

Lighthouse is the operator's check — see `docs/SECURITY.md` §*Manual Browser Checks*.
