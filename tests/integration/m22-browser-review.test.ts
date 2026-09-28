import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

// ── 1. Command palette entry ───────────────────────────────────────────────

describe('M2.2 review — the palette is openable without a browser-reserved key', () => {
  /**
   * The visible button, by the four things it has to carry — and the two it must not.
   *
   * What this sees: `Shell.tsx` renders a real `<button>` whose class, localized name and
   * `aria-expanded` are the ones the correction specified, and carries neither an
   * `aria-keyshortcuts` attribute nor a `<kbd>` hint. What it does not see: that the button is
   * on screen, that Enter and Space activate it, or that a screen reader announces it — those
   * are the native `<button>` and a real name, and they are in the browser evidence.
   *
   * `.command-trigger` rather than a class naming the palette: the client-style scan reads any
   * `className` holding "palette" as a hand-rolled overlay, which is the one thing this is not.
   */
  it('renders a visible, keyboard-accessible trigger in the authenticated shell', () => {
    const shell = client('Shell.tsx');
    expect(shell).toContain('<button');
    expect(shell).toContain('type="button"');
    expect(shell).toContain('className="btn command-trigger"');
    expect(shell).toContain("t('palette.title')");
    // The state it describes lives in the shell, which is what makes a button possible at all:
    // `showModal()` makes the rest of the document inert, so an opener inside the dialog could
    // never be activated a second time.
    expect(shell).toContain('const [paletteOpen, setPaletteOpen] = useState(false);');
    expect(shell).toContain('aria-expanded={paletteOpen}');

    // And the two things a real Windows check showed the previous correction got wrong: no
    // advertised chord and no printed key hint. A web page cannot promise either.
    expect(shell, 'the trigger must not advertise a global shortcut').not.toContain(
      'aria-keyshortcuts',
    );
    expect(shell, 'the trigger must not print a key hint').not.toContain('<kbd');
    expect(shell, 'the hint must not be read from the dictionary').not.toContain(
      'palette.shortcut',
    );
  });

  /**
   * Nothing is advertised, and the Windows Print chord is not bound.
   *
   * What this sees: the shell carries no `aria-keyshortcuts` at all; no client source rebinds
   * `Ctrl+Shift+P`; the stylesheet keeps no `.kbd` rule; and what is left of the handler is the
   * plain `Cmd/Ctrl+K` best-effort compatibility, still guarded by `event.shiftKey` so it cannot
   * claim `Ctrl+Shift+K` either. What it does not see: whether the retained chord ever arrives —
   * on Windows Chrome it may not, which is exactly why nothing promises it.
   */
  it('advertises no chord at all and binds no Ctrl+Shift+P', () => {
    const shell = client('Shell.tsx');
    const palette = client('CommandPalette.tsx');

    expect(shell).not.toContain('aria-keyshortcuts');

    // No `key === 'p'` binding survives anywhere in the client, in code rather than in prose.
    for (const file of clientFiles(/\.tsx?$/)) {
      const source = code(file);
      expect(source, `${relativeToClient(file)} still binds Ctrl+Shift+P`).not.toMatch(
        /key\s*===\s*'p'/,
      );
      expect(source, `${relativeToClient(file)} still renders a <kbd> hint`).not.toContain('<kbd');
    }
    expect(styleSheet('globals.css'), 'the hint class must be gone with the hint').not.toMatch(
      /\.kbd\s*\{/,
    );

    // The retained best-effort half: plain `k`, both modifiers, and a shift test it can only
    // fail — so `Ctrl+Shift+K` is not claimed by accident while `Ctrl+Shift+P` is not bound.
    expect(palette).toContain("key !== 'k'");
    expect(palette).toContain('event.shiftKey');
    expect(palette).not.toMatch(/shiftKey\s*&&/);
    expect(palette.indexOf('event.shiftKey')).toBeLessThan(
      palette.indexOf('event.preventDefault()'),
    );
  });

  /**
   * The guard, and the four controls it names.
   *
   * What this sees: the helper exists, names exactly `INPUT`, `TEXTAREA`, `SELECT` and
   * `contenteditable`, and is consulted *before* `preventDefault()` — so a keystroke inside a
   * form field is the field's and is never intercepted. What it does not see: the single
   * exception, which is the palette's own query field identified by reference — without it the
   * retained chord could not close the palette while that field has focus, and "repeated
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
   * No dictionary value is a hint, and none of them names a chord.
   *
   * What this sees: `palette.shortcut` is gone from both dictionaries, and every remaining
   * `palette.*` value matches neither `Ctrl+K`/`Cmd+K`/`⌘K` nor `Ctrl+Shift+P`. What it does
   * not see: a rendered `<kbd>` — the shell assertion above owns that, and the stylesheet one
   * owns the class it would have carried.
   */
  it('prints no key hint in either language', () => {
    expect(Object.keys(en)).not.toContain('palette.shortcut');
    expect(Object.keys(fa)).not.toContain('palette.shortcut');

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
        expect(value, `${lang}.${key} advertises the Windows Print chord`).not.toMatch(
          /Ctrl\+Shift\+P/i,
        );
      }
    }
  });

  /**
   * Documentation may explain why no chord is promised; it may not promise one.
   *
   * What this sees: no line of any specification both names a chord (`Ctrl…`, `Cmd…`, `⌘…`,
   * `Cmd/Ctrl`) and calls it `reliable` or a `guarantee` — the window is a line, so a claim
   * wrapped across a break is still caught. What it does not see: whether a chord works; that
   * is the operator's Windows check, reported rather than asserted, because headless Linux
   * cannot observe it.
   */
  it('calls no palette chord dependable in any specification', () => {
    const root = join(import.meta.dirname, '..', '..');
    const chord = /(?:Ctrl|Cmd|Control|⌘)\s*\+|Cmd\/Ctrl/;
    const promise = /reliable|guarantee/i;
    const docs = [
      ...readdirSync(join(root, 'docs')).map((name) => join('docs', name)),
      'PLAN.md',
      'CLAUDE.md',
      'README.md',
    ];
    expect(docs.length, 'the scan must actually have documents').toBeGreaterThan(5);
    const offenders = docs.flatMap((doc) =>
      readFileSync(join(root, doc), 'utf-8')
        .split('\n')
        .map((line, index) => `${doc}:${index + 1}: ${line}`)
        .filter((row) => chord.test(row) && promise.test(row)),
    );
    expect(offenders, 'a chord named and promised on one line').toEqual([]);
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
   * A pair wrapper's own external rhythm, on the shared rule.
   *
   * What this sees: `.pair` carries `margin-block-end: var(--s4)` — the token `.card` uses — and
   * only the end margin, so nothing stacks on the previous sibling's own end margin; its
   * children keep `margin-block-end: 0`, so the internal grid `gap` still has one owner; and the
   * rhythm is not `.pair + .pair`, which Security's interposed `<dialog>` would never match.
   * What it does not see: the measured 24px between Security's two wrappers — that is the
   * browser half of the evidence.
   */
  it('gives each pair wrapper the same external rhythm a card has', () => {
    const globals = styleSheet('globals.css');
    const pair = rule(globals, /\.pair \{/);
    expect(pair).toContain('margin-block-end: var(--s4);');
    // The shorthand would add a start margin that stacks on the previous sibling's own end
    // margin — the double gap Overview and Secrets must not gain.
    expect(pair, 'only the end margin, never the shorthand').not.toContain('margin-block:');
    expect(pair, 'no physical margin property').not.toMatch(/margin-(?:top|bottom)\s*:/);
    expect(styleSheet('tokens.css')).toMatch(/--s4: \d+px;/);
    expect(rule(globals, /\.card \{/)).toContain('margin-block-end: var(--s4);');
    expect(rule(globals, /\.pair > \.card \{/)).toContain('margin-block-end: 0;');
    expect(globals, 'not an adjacent sibling — a dialog sits between the wrappers').not.toContain(
      '.pair + .pair',
    );
    expect(client('Security.tsx')).toContain('<Dialog');
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
