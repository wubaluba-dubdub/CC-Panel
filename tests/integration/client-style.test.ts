import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  allDeclarations,
  clientFiles,
  declarationsOf,
  relativeToClient,
  stripCssComments,
  type Declaration,
} from '../helpers/css.js';

/**
 * The stylesheet's own rules, as scans.
 *
 * M2.1 shipped a design system whose values were tokens *by convention*: three ink tones were
 * defined once and then used for three unrelated reasons, one duration was written twice, and a
 * card did not own its edges — so a table laid out by its content drew its last column and every
 * row's divider across the card's border and out onto the page. Every rule below is one a review
 * would have caught once and then stopped catching.
 *
 *  1. **One token file.** `styles/tokens.css` is the only file that may hold a literal value or
 *     define a custom property. A colour, a duration, an easing curve or a raw `px` length
 *     anywhere else is a finding — including in TypeScript, where it would mean a value was
 *     being computed for a `style` attribute the CSP blocks anyway.
 *  2. **Containment.** A card clips and the region inside it scrolls.
 *  3. **Overlays are top-layer.** Once a card clips, a positioned descendant of one cannot
 *     escape it: every overlay is a real `<dialog>` opened with `showModal()`, which the browser
 *     promotes out of every clipping and stacking context on the page. M2.2's command palette is
 *     the next thing this decides, and a palette clipped by a card is exactly the defect this
 *     scan exists to stop repeating.
 *
 * Same mechanism as `client-discipline.test.ts` and the client-IP scan: read the files, strip
 * comments, report every finding with the line and what to use instead.
 */

const TOKEN_FILE = 'styles/tokens.css';

/** Value patterns that may appear only in the token file. */
const LITERALS: { name: string; pattern: RegExp; instead: string }[] = [
  { name: 'hex colour', pattern: /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/, instead: 'a colour token from tokens.css' },
  {
    name: 'colour function',
    pattern: /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(/,
    instead: 'a colour token from tokens.css',
  },
  {
    name: 'named colour',
    // `transparent`, `currentColor` and the CSS-wide keywords are not palette values: they mean
    // "none", "whatever the text is" and "unset". Everything else names a colour and belongs in
    // the token file.
    pattern: /\b(?:white|black|red|green|blue|gray|grey|silver|maroon|olive|lime|aqua|teal|navy|fuchsia|purple|orange|yellow|pink|brown|gold|beige|ivory|azure|coral|crimson|indigo|khaki|lavender|magenta|salmon|tan|violet|wheat)\b/,
    instead: 'a colour token from tokens.css',
  },
  {
    name: 'duration',
    pattern: /(?<![\w.-])\d+(?:\.\d+)?m?s(?![\w-])/,
    instead: 'a --t-* token from tokens.css',
  },
  {
    name: 'easing curve',
    pattern: /\b(?:cubic-bezier|steps|linear)\(/,
    instead: '--ease from tokens.css',
  },
  {
    name: 'raw px length',
    // The one place CSS gives no alternative is an `@media` condition, which is evaluated before
    // custom properties are substituted — and a condition never appears in a declaration's
    // value, so it is excluded structurally rather than by an exception.
    pattern: /(?<![\w.-])-?\d+(?:\.\d+)?px\b/,
    instead: 'a spacing, radius or size token from tokens.css',
  },
];

/** `position: absolute` is fine where the thing is *placed*; each one is named here. */
const POSITIONED = new Map<string, string>([
  ['.visually-hidden', 'the clip-rect that keeps a caption in the accessibility tree and off the screen'],
  ['.skip', 'the skip link parks off-screen and comes back on focus'],
  ['.card::before', 'the one-pixel inner top highlight, inside the card it belongs to'],
  ['.select-wrap::after', 'the chevron, over the select it belongs to'],
]);

function literalFindings(decls: Declaration[]): string[] {
  const out: string[] = [];
  for (const decl of decls) {
    if (decl.file === TOKEN_FILE) continue;
    for (const { name, pattern, instead } of LITERALS) {
      if (pattern.test(decl.value)) {
        out.push(`${decl.file}:${decl.line} ${name} in \`${decl.property}: ${decl.value}\` — use ${instead}`);
      }
    }
  }
  return out;
}

describe('M2.1.1 — one token file, and a scan that makes it the only one', () => {
  it('defines every custom property in tokens.css and nowhere else', () => {
    const offenders = allDeclarations()
      .filter((decl) => decl.property.startsWith('--') && decl.file !== TOKEN_FILE)
      .map((decl) => `${decl.file}:${decl.line} defines ${decl.property}`);
    expect(offenders).toEqual([]);
    // And the token file actually holds them, so the rule is not vacuous.
    const tokens = declarationsOf(clientFiles(/^tokens\.css$/)[0]!).filter((d) => d.property.startsWith('--'));
    expect(tokens.length).toBeGreaterThan(40);
  });

  it('holds no colour, duration, easing curve or raw px length outside the token file', () => {
    expect(literalFindings(allDeclarations())).toEqual([]);
  });

  it('holds no colour and no duration in TypeScript either', () => {
    // A colour in a component would mean a value was being computed for a `style` attribute,
    // which `style-src 'self'` blocks — so this is the same rule as the style-prop ban seen from
    // the other side.
    const offenders: string[] = [];
    for (const file of clientFiles(/\.tsx?$/)) {
      const rel = relativeToClient(file);
      for (const [index, line] of readFileSync(file, 'utf-8').split('\n').entries()) {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/\/\*.*?\*\//g, '');
        for (const { name, pattern, instead } of LITERALS) {
          if (name === 'raw px length' || name === 'easing curve') continue;
          if (pattern.test(code)) offenders.push(`${rel}:${index + 1} ${name} — use ${instead}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('scans values that would fail it — the patterns are not vacuous', () => {
    const samples: Record<string, string[]> = {
      'hex colour': ['#0a0a0b', '1px solid #fff'],
      'colour function': ['rgb(0 0 0 / 60%)', 'oklch(70% 0.1 250)'],
      'named colour': ['white', '1px solid black'],
      duration: ['150ms', '0.2s', 'opacity 150ms var(--ease)'],
      'easing curve': ['cubic-bezier(0.2, 0, 0.2, 1)', 'steps(4, end)'],
      'raw px length': ['8px', 'calc(100% - 12px)', '-9999px'],
    };
    for (const { name, pattern } of LITERALS) {
      for (const sample of samples[name]!) {
        expect(pattern.test(sample), `${name} should match ${sample}`).toBe(true);
      }
    }
    // And the forms it must not catch, which is the other half: a scan that flagged `var()`,
    // `transparent` or a `ch` measure would be worked around within a day.
    for (const { name, pattern } of LITERALS) {
      for (const good of [
        'var(--accent)',
        'transparent',
        'currentColor',
        'var(--border-w) solid var(--hairline)',
        '76ch',
        '100%',
        '0.95em',
        'inset(50%)',
        'ease-in-out',
        'var(--t-fast) var(--ease)',
        'U+0600-06FF',
        'minmax(0, 1fr)',
      ]) {
        expect(pattern.test(good), `${name} matched ${good}`).toBe(false);
      }
    }
  });
});

describe('M2.1.1 — a container owns its edges', () => {
  const decls = allDeclarations();

  it('makes the card a clipping context, with a fallback for an engine that lacks `clip`', () => {
    const card = decls.filter((d) => d.context.at(-1) === '.card' && d.property === 'overflow');
    expect(card.map((d) => d.value)).toEqual(['hidden', 'clip']);
  });

  it('puts the scroll on the region inside the card, never on the card', () => {
    const region = decls.filter((d) => d.context.at(-1) === '.scroll-x');
    expect(region.find((d) => d.property === 'overflow-x')?.value).toBe('auto');
    // `stable`, so nothing on the screen moves when a scrollbar appears.
    expect(region.find((d) => d.property === 'scrollbar-gutter')?.value).toBe('stable');
    expect(region.find((d) => d.property === 'scrollbar-width')?.value).toBe('thin');
    expect(region.some((d) => d.property === 'scrollbar-color')).toBe(true);
  });
});

describe('M2.1.1 — every overlay is in the top layer', () => {
  it('positions nothing `fixed`, and nothing `absolute` that is not named', () => {
    const offenders: string[] = [];
    for (const decl of allDeclarations()) {
      if (decl.property !== 'position') continue;
      if (decl.value === 'fixed') {
        offenders.push(`${decl.file}:${decl.line} position: fixed — an overlay must be a <dialog> in the top layer`);
      }
      if (decl.value === 'absolute') {
        const selector = decl.context.at(-1) ?? '';
        if (!POSITIONED.has(selector)) {
          offenders.push(`${decl.file}:${decl.line} position: absolute on ${selector} is not in the allowlist`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The allowlist is not stale: every selector in it is still in the stylesheet.
    const positioned = new Set(
      allDeclarations()
        .filter((d) => d.property === 'position' && d.value === 'absolute')
        .map((d) => d.context.at(-1)),
    );
    for (const selector of POSITIONED.keys()) {
      expect(positioned.has(selector), `${selector} is allowlisted and no longer exists`).toBe(true);
    }
  });

  it('renders every overlay as a <dialog> opened with showModal()', () => {
    const offenders: string[] = [];
    let dialogs = 0;
    for (const file of clientFiles(/\.tsx?$/)) {
      const rel = relativeToClient(file);
      const source = readFileSync(file, 'utf-8');
      const code = stripCssComments(source)
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
        .join('\n');
      const opens = [...code.matchAll(/<dialog\b/g)].length;
      dialogs += opens;
      if (opens > 0 && rel !== 'components/ui.tsx') {
        offenders.push(`${rel} renders a <dialog> — every overlay goes through <Dialog> in components/ui.tsx`);
      }
      // The two APIs that put an element in the top layer. Anything else — a positioned div, a
      // portal into document.body — is inside some ancestor's clipping context.
      if (/className=(?:"|{')[^"']*(?:overlay|modal|popup|palette|dropdown)/.test(code)) {
        offenders.push(`${rel} names an overlay class; the overlay must be a <dialog>`);
      }
    }
    expect(offenders).toEqual([]);
    expect(dialogs, 'no <dialog> in the client at all').toBeGreaterThan(0);
    expect(readFileSync(clientFiles(/^ui\.tsx$/)[0]!, 'utf-8')).toContain('.showModal()');
  });
});

describe('M2.1.1 — one table primitive, and one place that renders a table', () => {
  const PRIMITIVE = 'components/Table.tsx';

  it('renders every <table>, <colgroup> and <caption> in the primitive and nowhere else', () => {
    const offenders: string[] = [];
    for (const file of clientFiles(/\.tsx?$/)) {
      const rel = relativeToClient(file);
      if (rel === PRIMITIVE) continue;
      // Comments are stripped first: prose *about* the rule is the point of the rule, and both
      // `lib/table.ts` and `components/ui.tsx` explain this one in theirs.
      const code = readFileSync(file, 'utf-8')
        .split('\n')
        .map((line) =>
          line
            .replace(/\/\*.*?\*\//g, '')
            .replace(/\/\/.*$/, '')
            .replace(/^\s*\*.*$/, ''),
        )
        .join('\n');
      for (const tag of ['<table', '<colgroup', '<caption', '<thead']) {
        if (code.includes(tag)) offenders.push(`${rel} renders ${tag} — use <DataTable> or <KeyValueTable>`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('builds the colgroup and the header row from the same array', () => {
    // This is what makes "the colgroup declares exactly as many columns as the header row has
    // cells" true by construction rather than by inspection. The third mapping — a row's cells —
    // is a `Record` keyed on the same column keys, so a missing cell is a compile error.
    const source = readFileSync(clientFiles(/^Table\.tsx$/)[0]!, 'utf-8');
    expect(source).toContain('spec.columns.map((column) => (\n            <col');
    expect(source).toContain('spec.columns.map((column) => (\n              <th scope="col"');
    expect(source).toContain('spec.columns.map((column) => (\n          <td');
    // The caption is the accessible name and is not drawn.
    expect(source).toContain('<caption className="visually-hidden">');
    // A detail row spans every column, so it cannot be mistaken for a row of cells.
    expect(source).toContain('colSpan={span}');
  });

  it('gives the scroll region a name and deliberately no tab stop', () => {
    const source = readFileSync(clientFiles(/^ui\.tsx$/)[0]!, 'utf-8');
    expect(source).toContain('<div className="scroll-x" role="region" aria-label={label}>');
    // Reasoned in the component's own comment: Chrome 127+ already focuses a scroller that has no
    // focusable descendant, every row here has one, and an explicit stop would be dead in the
    // common case where the table is not overflowing at all.
    const region = source.slice(source.indexOf('export function ScrollRegion'));
    expect(region.includes('tabIndex'), 'the scroll region took a tab stop').toBe(false);
  });

  it('keys the routed region by the route and by nothing else', () => {
    // A key carrying a polled value would remount the screen every two seconds and replay the
    // enter animation while the operator was reading it.
    const shell = readFileSync(clientFiles(/^Shell\.tsx$/)[0]!, 'utf-8');
    expect(shell).toContain('<div className="screen" key={route.name}>');
    const offenders: string[] = [];
    for (const file of clientFiles(/\.tsx$/)) {
      const rel = relativeToClient(file);
      for (const [index, line] of readFileSync(file, 'utf-8').split('\n').entries()) {
        if (!/\bkey=\{/.test(line)) continue;
        if (/\bkey=\{[^}]*(?:metrics|sampledAt|Date\.now|percent|usedBytes|revealLeft|remaining)/.test(line)) {
          offenders.push(`${rel}:${index + 1} keys an element on a polled value`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('M2.1.1 — one instant formatter', () => {
  it('constructs an Intl.DateTimeFormat in exactly one file', () => {
    // Every timestamp in the panel goes through `<Time>` and therefore through `formatInstant`.
    // A second construction site is how a second date format appears on a second screen — which
    // is what happened: the reported ambiguous `05/09/2026` came from `dateStyle: 'short'`.
    const offenders: string[] = [];
    for (const file of clientFiles(/\.tsx?$/)) {
      const rel = relativeToClient(file);
      const code = readFileSync(file, 'utf-8')
        .split('\n')
        .map((line) =>
          line
            .replace(/\/\*.*?\*\//g, '')
            .replace(/\/\/.*$/, '')
            .replace(/^\s*\*.*$/, ''),
        )
        .join('\n');
      if (/new Intl\.DateTimeFormat/.test(code) && rel !== 'lib/format.ts') {
        offenders.push(`${rel} constructs an Intl.DateTimeFormat — use formatInstant`);
      }
    }
    expect(offenders).toEqual([]);
    expect(readFileSync(clientFiles(/^format\.ts$/)[0]!, 'utf-8')).toContain('new Intl.DateTimeFormat');
  });

  it('renders every timestamp through the one component', () => {
    // `<Time>` is what makes the `nowrap`, the mono face, the LTR isolation and the exact-instant
    // title unavoidable rather than remembered.
    const offenders: string[] = [];
    for (const file of clientFiles(/\.tsx$/)) {
      const rel = relativeToClient(file);
      if (rel === 'components/Time.tsx') continue;
      const code = readFileSync(file, 'utf-8');
      if (/\bformatInstant\(/.test(code)) offenders.push(`${rel} formats an instant itself`);
      if (/<time\b/.test(code)) offenders.push(`${rel} renders a <time> element`);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Motion, as three scans.
 *
 * The operator asked for soft animation. What makes that safe on this panel rather than merely
 * pretty is the two rules below, and both are the kind that hold on the first component and rot by
 * the fortieth — so neither is a convention.
 */

/** The only properties this panel animates, and why each is on the list. */
const ANIMATABLE = new Map<string, string>([
  ['opacity', 'composited, no layout, no paint invalidation'],
  ['transform', 'composited; the press scale, the chevron and the screen enter'],
  ['--gauge-fill', 'registered with @property, so it interpolates; the gauge'],
  ['background-color', 'a paint, not a layout: a hovered row and a hovered button'],
  ['border-color', 'a paint: a hovered control'],
  ['color', 'a paint: a hovered link and the expander'],
  // The two discrete ones. Neither interpolates, and that is the point: they flip once, at the
  // end, which is what keeps a closing dialog rendered and in the top layer while its opacity and
  // transform play. They are only allowed with `allow-discrete`, which the scan checks.
  ['display', 'discrete only — keeps a closing dialog rendered while its opacity plays'],
  ['overlay', 'discrete only — keeps a closing dialog in the top layer while its opacity plays'],
]);

const GUARD = '@media (prefers-reduced-motion: no-preference)';

/** Splits a comma-separated value without splitting inside `var(…)` or `cubic-bezier(…)`. */
function topLevelParts(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** True for a declaration that switches motion *off*, which is allowed anywhere. */
function isDeAnimation(value: string): boolean {
  return /^(?:none|0s|0ms|var\(--t-none\))$/.test(value.trim());
}

describe('M2.1.1 — motion is inside the reduced-motion guard', () => {
  it('puts every transition, animation and @keyframes rule inside it', () => {
    const offenders: string[] = [];
    for (const decl of allDeclarations()) {
      const animating =
        /^(?:transition|animation)(?:-|$)/.test(decl.property) ||
        decl.context.some((one) => one.startsWith('@keyframes'));
      if (!animating) continue;
      // A zero duration or `none` is a de-animation, not an animation, and has to be sayable
      // outside the guard — the gauge's explicit `transition-duration: var(--t-none)` under
      // `reduce` is the one place that matters.
      if (isDeAnimation(decl.value)) continue;
      if (!decl.context.includes(GUARD)) {
        offenders.push(
          `${decl.file}:${decl.line} \`${decl.property}: ${decl.value}\` is outside ${GUARD}`,
        );
      }
    }
    expect(offenders).toEqual([]);
    // Not vacuous: there is motion to guard.
    const guarded = allDeclarations().filter(
      (decl) => decl.context.includes(GUARD) && /^transition|^animation/.test(decl.property),
    );
    expect(guarded.length).toBeGreaterThan(4);
  });

  it('animates only the properties on the allowlist', () => {
    const offenders: string[] = [];
    for (const decl of allDeclarations()) {
      // A property declared inside a @keyframes block is animated by definition.
      if (decl.context.some((one) => one.startsWith('@keyframes'))) {
        if (!ANIMATABLE.has(decl.property)) {
          offenders.push(`${decl.file}:${decl.line} @keyframes animates ${decl.property}`);
        }
        continue;
      }
      if (decl.property !== 'transition' && decl.property !== 'transition-property') continue;
      if (isDeAnimation(decl.value)) continue;
      for (const part of topLevelParts(decl.value)) {
        const property = part.split(/\s+/)[0]!;
        if (!ANIMATABLE.has(property)) {
          offenders.push(`${decl.file}:${decl.line} transitions ${property}, which is not on the allowlist`);
          continue;
        }
        // `display` and `overlay` do not interpolate. Transitioned without `allow-discrete` they
        // would flip on the first frame and the exit would play behind the page.
        if ((property === 'display' || property === 'overlay') && !part.includes('allow-discrete')) {
          offenders.push(`${decl.file}:${decl.line} transitions ${property} without allow-discrete`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('scans values that would fail it — the patterns are not vacuous', () => {
    expect(topLevelParts('opacity var(--t-fast) var(--ease), transform var(--t-slow) var(--ease)')).toEqual([
      'opacity var(--t-fast) var(--ease)',
      'transform var(--t-slow) var(--ease)',
    ]);
    // A `cubic-bezier(a, b, c, d)` inline would otherwise split into four parts.
    expect(topLevelParts('height cubic-bezier(0.2, 0, 0.2, 1)')).toEqual([
      'height cubic-bezier(0.2, 0, 0.2, 1)',
    ]);
    for (const forbidden of ['height', 'inline-size', 'inset-block-start', 'margin', 'filter', 'background-position']) {
      expect(ANIMATABLE.has(forbidden), `${forbidden} must not be animatable`).toBe(false);
    }
    expect(isDeAnimation('none')).toBe(true);
    expect(isDeAnimation('var(--t-none)')).toBe(true);
    expect(isDeAnimation('opacity var(--t-fast) var(--ease)')).toBe(false);
  });

  it('registers --gauge-fill, because an unregistered property interpolates discretely', () => {
    // The absence of this block is invisible: the transition applies, does nothing, and looks
    // exactly like an animation nobody added.
    const registration = allDeclarations().filter((decl) =>
      decl.context.some((one) => one === '@property --gauge-fill'),
    );
    const descriptor = (name: string): string | undefined =>
      registration.find((decl) => decl.property === name)?.value;
    expect(descriptor('syntax')).toBe("'<percentage>'");
    expect(descriptor('inherits')).toBe('false');
    expect(descriptor('initial-value')).toBe('0%');
    // And the transition it exists for.
    const gauge = allDeclarations().find(
      (decl) => decl.context.at(-1) === '.gauge-bar' && decl.property === 'transition',
    );
    expect(gauge?.value).toContain('--gauge-fill');
    expect(gauge?.context).toContain(GUARD);
    // Switched off explicitly under `reduce`, not merely left out.
    const off = allDeclarations().find(
      (decl) =>
        decl.context.includes('@media (prefers-reduced-motion: reduce)') &&
        decl.property === 'transition-duration',
    );
    expect(off?.value).toBe('var(--t-none)');
  });
});
