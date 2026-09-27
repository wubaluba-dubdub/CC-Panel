import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { clientFiles, relativeToClient, stripCssComments } from '../helpers/css.js';
import { en } from '../../src/client/i18n/en.js';
import fa from '../../src/client/i18n/fa.js';

/**
 * The browser review's corrections, as the scans a Node test can run.
 *
 * `Vitest` runs with `environment: 'node'` and the test tsconfig has no `jsx`, so nothing here
 * imports a `.tsx` file — a test that did would fail to compile, not to pass. What is left is
 * source text, and source text is the right level for every one of these: each is a decision
 * about *which* attribute, *which* combination and *which* rule the file reaches for, made
 * while the file is written and invisible afterwards.
 *
 * What none of them can see is the rendered layout — that a card is the same width as the card
 * above it, that `.pair` is really two columns at 1440, that a Persian title is one word. Those
 * are the browser's half of the evidence, and they are in the report rather than here.
 *
 * Each assertion states what it sees. The last group states what none of them can see.
 */

/** Source with comments removed, so a rule is not satisfied by the sentence describing it. */
function code(file: string): string {
  return readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function client(relative: string): string {
  // `clientFiles` matches a file's *name*, and every client file name is unique.
  const name = relative.slice(relative.lastIndexOf('/') + 1);
  return code(clientFiles(new RegExp(`^${name.replace('.', '\\.')}$`))[0]!);
}

function styleSheet(name: 'globals.css' | 'tokens.css'): string {
  return stripCssComments(readFileSync(`src/client/styles/${name}`, 'utf-8'));
}

/** The body of the first rule whose selector matches, comments stripped. */
function rule(css: string, selector: RegExp): string {
  const match = css.match(selector);
  expect(match, `no rule matching ${selector}`).not.toBeNull();
  // The selector pattern includes the opening brace, so the slice starts just past it; the
  // brace in the pattern below is optional to keep either form of selector usable.
  const body = css.slice(match!.index! + match![0].length).match(/^\s*\{?([^}]*)\}/);
  expect(body, `selector ${selector} is not followed by a block`).not.toBeNull();
  return body![1]!;
}

/** `Control` is the combination's spelling and `ctrl` is the event property's. */
function modifierProperty(modifier: string): string {
  return modifier === 'Control' ? 'ctrl' : modifier.toLowerCase();
}

// ── 1. Command palette entry ───────────────────────────────────────────────

describe('M2.2 review — the palette is openable without a browser-reserved key', () => {
  /**
   * The visible button, by the three things it has to carry.
   *
   * What this sees: `Shell.tsx` renders a real `<button>` whose class, accessible shortcut
   * advertisement and localized hint are the ones the correction specified. What it does not
   * see: that the button is on screen, that Enter and Space activate it, or that a screen
   * reader announces it — those are the native `<button>` and a real name, and they are in the
   * browser evidence.
   *
   * `.command-trigger` rather than a class naming the palette: the client-style scan reads any
   * `className` holding "palette" as a hand-rolled overlay, which is the one thing this is not.
   */
  it('renders a visible, keyboard-accessible trigger in the authenticated shell', () => {
    const shell = client('Shell.tsx');
    expect(shell).toContain('<button');
    expect(shell).toContain('type="button"');
    expect(shell).toContain('className="btn command-trigger"');
    expect(shell).toContain('aria-keyshortcuts="Control+Shift+P Meta+K"');
    expect(shell).toContain("t('palette.title')");
    expect(shell).toContain("t('palette.shortcut')");
    // The state it describes lives in the shell, which is what makes a button possible at all:
    // `showModal()` makes the rest of the document inert, so an opener inside the dialog could
    // never be activated a second time.
    expect(shell).toContain('const [paletteOpen, setPaletteOpen] = useState(false);');
    expect(shell).toContain('aria-expanded={paletteOpen}');
  });

  /**
   * Every advertised combination is bound, and `Control+K` is not advertised.
   *
   * What this sees: each entry of the `aria-keyshortcuts` string, decomposed into modifiers and
   * a key, and then a token for each of them in the handler. What it does not see: whether the
   * key actually arrives — which on Windows Chrome it may not, and that is precisely why the
   * combination Chrome claims is the one left off the list. A shortcut the browser can swallow
   * is not one the button should promise.
   */
  it('advertises only shortcuts the handler binds', () => {
    const shell = client('Shell.tsx');
    const palette = client('CommandPalette.tsx');
    const raw = shell.match(/aria-keyshortcuts="([^"]+)"/);
    expect(raw, 'the trigger must carry aria-keyshortcuts').not.toBeNull();
    const advertised = raw![1]!.split(/\s+/);
    expect(advertised.length).toBeGreaterThan(0);

    for (const combination of advertised) {
      const parts = combination.split('+');
      const key = parts.pop()!.toLowerCase();
      expect(palette, `${combination}: no binding for key ${key}`).toContain(`key === '${key}'`);
      for (const modifier of parts) {
        const token = `event.${modifierProperty(modifier)}Key`;
        expect(palette, `${combination}: no binding for ${modifier}`).toContain(token);
      }
    }

    expect(advertised).not.toContain('Control+K');
    expect(advertised).not.toContain('Meta+Shift+K');
    // And the reliable one is reachable only with both of its modifiers, so a stray
    // `Ctrl+P` (the browser's own print command) is not stolen by this handler.
    expect(palette).toContain('event.ctrlKey && event.shiftKey && key === \'p\'');
  });

  /**
   * The guard, and the four controls it names.
   *
   * What this sees: the helper exists, names exactly `INPUT`, `TEXTAREA`, `SELECT` and
   * `contenteditable`, and is consulted *before* `preventDefault()` — so a keystroke inside a
   * form field is the field's and is never intercepted. What it does not see: the single
   * exception, which is the palette's own query field identified by reference — without it the
   * combination that opened the palette could not close it while it has focus, and "repeated
   * activation closes" would be unreachable rather than merely untested.
   */
  it('never fires while the operator is typing in a control they own', () => {
    const palette = client('CommandPalette.tsx');
    expect(palette).toContain('function isTypingTarget');
    expect(palette).toContain("tag === 'INPUT'");
    expect(palette).toContain("tag === 'TEXTAREA'");
    expect(palette).toContain("tag === 'SELECT'");
    expect(palette).toContain('target.isContentEditable');

    const handler = palette.slice(
      palette.indexOf('const onKeyDown'),
      palette.indexOf('window.addEventListener'),
    );
    expect(handler, 'the handler must consult the guard').toContain('isTypingTarget(event.target)');
    expect(handler.indexOf('isTypingTarget(event.target)')).toBeLessThan(
      handler.indexOf('event.preventDefault()'),
    );
    // A plain key with no modifier at all is never the palette's.
    expect(handler).toContain('!event.metaKey && !event.ctrlKey');
  });

  /**
   * One boolean, one dialog, one owner.
   *
   * What this sees: `CommandPalette.tsx` takes `open` as a prop and does **not** declare its
   * own `useState(false)`. What it does not see: that a second activation cannot stack — with
   * a single component instance and a boolean there is no second palette to create, and the
   * close half is the `Dialog` state machine, which is asserted in `m22-ui.test.ts`.
   */
  it('cannot stack: the open state has exactly one owner', () => {
    const palette = client('CommandPalette.tsx');
    const shell = client('Shell.tsx');
    expect(palette).not.toContain('useState(false)');
    expect(palette).toContain('open: boolean;');
    expect(palette).toContain('setOpen: (next: boolean) => void;');
    expect(shell).toContain('open={paletteOpen}');
    expect(shell).toContain('setOpen={setPaletteOpen}');
  });

  /**
   * The hint is the guaranteed combination, in both languages.
   *
   * What this sees: the rendered hint is `Ctrl+Shift+P`, the Persian value is not a copy of it
   * (the dictionary test would fail anyway), and **no** `palette.*` value in either language
   * names `Ctrl+K`, `Cmd+K` or `⌘K`. What it does not see: a claim about Chrome's omnibox —
   * the prohibition is on the string, so a test can never encode one.
   */
  it('prints a hint that is true on the platform the operator is using', () => {
    expect(en['palette.shortcut']).toBe('Ctrl+Shift+P');
    expect(fa['palette.shortcut']).not.toBe(en['palette.shortcut']);

    const paletteKeys = Object.keys(en).filter((key) => key.startsWith('palette.'));
    expect(paletteKeys.length).toBeGreaterThan(5);
    for (const key of paletteKeys) {
      for (const [lang, value] of [
        ['en', en[key as keyof typeof en]],
        ['fa', fa[key as keyof typeof fa]],
      ] as const) {
        expect(value, `${lang}.${key} advertises a browser-reserved key`).not.toMatch(
          /(?:Ctrl|Cmd|Control|⌘)\+K\b/,
        );
      }
    }
  });
});

// ── 2. Shared layout ───────────────────────────────────────────────────────

describe('M2.2 review — one content grid, two measures, one field measure', () => {
  /**
   * The screen container centres itself in the column the shell leaves for it.
   *
   * What this sees: `.main` has `margin-inline: auto` beside the `--measure-wide` cap. What it
   * does not see: the remainder of the column being equal on both sides — that is the before
   * and after measurement, 661px of background on one side at 1920 and none after. `margin-inline`
   * rather than `margin-left` is what the discipline scan enforces separately.
   */
  it('centres the routed region instead of pinning it to the navigation column', () => {
    const globals = styleSheet('globals.css');
    const main = rule(globals, /\.main \{/);
    expect(main).toContain('margin-inline: auto;');
    expect(main).toContain('max-inline-size: var(--measure-wide);');
    expect(main).toContain('inline-size: 100%;');
  });

  /**
   * The clamp, and the explicit list of what is not prose.
   *
   * What this sees: every direct child of the routed region starts at `--measure-prose`, and
   * exactly five selectors opt out — a card, the element two cards sit in, and the tab strip
   * and tab panel that have to be the width of the card the panel contains. What it does not
   * see: a card being full width *of the grid* rather than of the viewport; that is `.main`'s
   * cap, asserted above.
   */
  it('clamps prose to the reading measure and lets the grid sections through', () => {
    const globals = styleSheet('globals.css');
    expect(rule(globals, /\.screen > \* \{/)).toContain('max-inline-size: var(--measure-prose);');

    const optOut = globals.match(
      /\.screen > \.card,\s*\.screen > \.card-wide,\s*\.screen > \.pair,\s*\.screen > \.tablist,\s*\.screen > \.tabpanel \{[^}]*\}/,
    );
    expect(optOut, 'the non-prose sections must opt out together, on specificity not order').not.toBeNull();
    expect(optOut![0]).toContain('max-inline-size: none;');
    // The classes the markup actually uses, so the list cannot drift from the screens.
    for (const page of ['Overview', 'Security', 'Secrets', 'Sessions', 'Audit', 'Project']) {
      expect(client(`${page}.tsx`), `${page}.tsx never uses .pair or a Card`).toMatch(
        /className="pair"|<Card/,
      );
    }
  });

  /**
   * The pairing rule, as a responsive two-column grid that collapses.
   *
   * What this sees: `.pair` is a grid on `minmax(0, 1fr)` tracks, becomes two columns above the
   * breakpoint, and drops the card's own bottom margin so the gap is the only spacing. What it
   * does not see: two columns being wide enough — the threshold (1100px) is chosen so each track
   * is at least ~400px, which is what the card's own padding and a form inside it need.
   */
  it('pairs cards on an intentional two-column grid', () => {
    const globals = styleSheet('globals.css');
    expect(rule(globals, /\.pair \{/)).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(rule(globals, /\.pair \{/)).toContain('display: grid;');
    expect(rule(globals, /\.pair > \.card \{/)).toContain('margin-block-end: 0;');
    expect(globals).toMatch(
      /@media \(min-width: 1100px\) \{\s*\.pair \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
  });

  /**
   * Which screens pair, and which stay full width.
   *
   * What this sees: exactly one wrapper on Overview and Secrets, two on Security (four cards,
   * two pairs), and **none** on Projects — where the list and the create form are both full
   * width and aligned rather than one 598px and the other 991px. What it does not see: the
   * measured widths; that is the before/after matrix.
   */
  it('pairs Overview, Security and Secrets, and leaves Projects aligned instead', () => {
    const wrappers = (source: string): number => (source.match(/className="pair"/g) ?? []).length;
    expect(wrappers(client('Overview.tsx'))).toBe(1);
    expect(wrappers(client('Security.tsx'))).toBe(2);
    expect(wrappers(client('Secrets.tsx'))).toBe(1);
    expect(wrappers(client('Projects.tsx'))).toBe(0);
    expect(wrappers(client('Sessions.tsx'))).toBe(0);

    // Four cards, two pairs — the count is what stops a fifth card appearing unpaired.
    const security = client('Security.tsx');
    expect(security.match(/<Card /g) ?? []).toHaveLength(4);
    expect(client('Overview.tsx').match(/<Card /g) ?? []).toHaveLength(4);
  });

  /**
   * The field measure: one token, defined once, applied to controls and to nothing else.
   *
   * What this sees: `--measure-field` is declared only in `tokens.css`, read by `globals.css`
   * as `max-inline-size` on `.field input, .field textarea`. What it does not see: an input no
   * longer stretching to 943px across a full-width card — the widths are browser evidence. A
   * checkbox is unaffected because its `inline-size` is reset to `auto`, and the tables and
   * prose keep the grid: only the control is capped.
   */
  it('caps controls at the shared field measure and nothing else', () => {
    const tokens = styleSheet('tokens.css');
    const globals = styleSheet('globals.css');
    expect(tokens).toMatch(/--measure-field: \d+ch;/);
    expect(globals, 'a token may be read but never defined outside tokens.css').not.toContain(
      '--measure-field:',
    );
    const field = rule(globals, /\.field input,\s*\.field textarea \{/);
    expect(field).toContain('max-inline-size: var(--measure-field);');
    expect(field).toContain('inline-size: 100%;');
  });

  /**
   * Titles and navigation labels are one line; a project slug is not.
   *
   * What this sees: `white-space: nowrap` on `.screen > h1` and on `.side nav a`, and a reset
   * to `normal` on the `.ltr` island inside the title. What it does not see: that every title
   * in both dictionaries fits at 320px — the longest measured is 173 of 272 available — so the
   * rule cannot be what overflows, and the reset is what stops a forty-character slug from
   * being the one that does. Hiding overflow would have been the shortcut here; there is none.
   */
  it('keeps titles and navigation labels on one line without hiding overflow', () => {
    const globals = styleSheet('globals.css');
    expect(rule(globals, /\.screen > h1 \{/)).toContain('white-space: nowrap;');
    expect(rule(globals, /\.screen > h1 \.ltr \{/)).toContain('white-space: normal;');
    expect(rule(globals, /\.side nav a \{/)).toContain('white-space: nowrap;');
    // The tab strip already did, and it is the other place a two-word label lives.
    expect(rule(globals, /\.tab \{/)).toContain('white-space: nowrap;');
  });
});

// ── 3. Disabled tabs ───────────────────────────────────────────────────────

describe('M2.2 review — an unbuilt tab looks unbuilt', () => {
  /**
   * Three signals, none of them the cursor.
   *
   * What this sees: the disabled rule sets tertiary ink, `cursor: default` and a dotted
   * underline; the base `.tab` sits at secondary ink so an unselected-but-available tab is no
   * longer the same colour; and the hover rule excludes `[aria-disabled='true']` so an
   * available tab answers the pointer and an unbuilt one does not. What it does not see: the
   * focus-visible state — the global ring applies to both, deliberately, because a tab that
   * cannot be reached is a tab a screen-reader user never learns exists.
   */
  it('separates an unbuilt tab from an available one in default, hover and focus', () => {
    const globals = styleSheet('globals.css');
    const disabled = rule(globals, /\.tab\[aria-disabled='true'\] \{/);
    expect(disabled).toContain('cursor: default;');
    expect(disabled).toContain('color: var(--ink-tertiary);');
    expect(disabled).toContain('text-decoration: underline;');
    expect(disabled).toContain('text-decoration-style: dotted;');

    const available = rule(globals, /\.tab \{/);
    expect(available, 'an available tab must not share the unbuilt colour').toContain(
      'color: var(--ink-secondary);',
    );

    expect(rule(globals, /\.tab:hover:not\(\[aria-disabled='true'\]\) \{/)).toContain(
      'color: var(--ink-primary);',
    );
  });

  /**
   * The control itself is untouched.
   *
   * What this sees: `Project.tsx` still uses `aria-disabled` and never the `disabled`
   * attribute, and the reason is still an `aria-describedby` target. What it does not see: the
   * tab being activatable — there is no route behind it and no `onClick`.
   */
  it('keeps the accepted behaviour and only changes how it looks', () => {
    const project = client('Project.tsx');
    expect(project).toContain('aria-disabled="true"');
    expect(project).toContain('aria-describedby="tab-unbuilt"');
    // Not the `disabled` attribute — that takes the control out of the tab order. The pattern
    // needs whitespace or a quote in front, so `aria-disabled=` (the thing being kept) cannot
    // satisfy it by accident.
    expect(project).not.toMatch(/[\s"']disabled=/);
    expect(rule(styleSheet('globals.css'), /\.tab \{/)).not.toContain('opacity');
  });
});

// ── 4. Build identity ──────────────────────────────────────────────────────

describe('M2.2 review — the build id is rendered once, in an LTR island', () => {
  /**
   * One reader, one island, no gate.
   *
   * What this sees: exactly one component (`.tsx`, comments stripped) reads `buildId`, and it
   * does so inside `<Ltr>` behind a `null` check, with no reference to the authentication stage
   * in that component. What it does not see: the network response carrying `feedfac` — that is
   * the browser — nor the pre-auth absence, which `build-id-preauth.test.ts` and
   * `build.test.ts` own. `i18n/*.ts` are not in the reader set because they hold the *label*
   * (`app.buildId`), which this asserts separately.
   */
  it('renders the build id through an LTR island and nothing else', () => {
    const readers = clientFiles(/\.tsx$/)
      .filter((file) => code(file).includes('buildId'))
      .map(relativeToClient)
      .sort();
    expect(readers).toEqual(['Shell.tsx']);
    expect(en['app.buildId']).toContain('{id}');
    expect(fa['app.buildId']).toContain('{id}');

    const shell = client('Shell.tsx');
    expect(shell).toContain('me.buildId === null ? null :');
    expect(shell).toContain('<Ltr>{me.buildId}</Ltr>');
    // A step-up dialog is not evidence of full versus pre authentication, so nothing here may
    // consult it: the identity area renders for any full session.
    expect(shell).not.toContain('stepUp');
    expect(shell).not.toContain("stage ===");
  });
});
