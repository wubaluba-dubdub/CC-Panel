import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const CLIENT_ROOT = join(import.meta.dirname, '..', '..', 'src', 'client');
const PACKAGE_JSON = join(import.meta.dirname, '..', '..', 'package.json');

/**
 * The three client rules that have to hold on component number forty, not just on the first
 * one — so they are a scan rather than a convention.
 *
 * Same mechanism as `cookie-discipline.test.ts` and the client-IP scan: read every file, strip
 * comments, and report every line that matches. Prose *about* a rule is the point of the rule,
 * so only code counts. No new tooling, and the project already trusts this shape.
 *
 *  1. **Logical properties only** (R3). Persian is right-to-left and direction has to be a
 *     setting rather than a rewrite. This is the check that stops the rule rotting.
 *  2. **No runtime CSS-in-JS.** `style-src 'self'` with no `unsafe-inline` blocks a `<style>`
 *     element and a `style` attribute, and a nonce is not available because the panel does no
 *     server-side rendering. The whole styled-components/emotion family is therefore unusable
 *     here regardless of what it supports.
 *  3. **No data-dependent value in a `style` prop.** MDN's `style-src-attr` page says setting
 *     properties on an element's `style` *object* is not blocked, which is the CSSOM path
 *     React DOM uses for `style={{}}` — but browsers have historically reported a violation for
 *     that path while still applying the style, and the one data-driven component in this panel
 *     is not resting on that. Values go through `setProperty('--x', v)` and are read with
 *     `var()`.
 */

// ── 1. Logical properties ────────────────────────────────────────────────────

/**
 * The physical properties, and the logical property each one should have been.
 *
 * Written as a map rather than a list so the failure message says what to use instead: a scan
 * that only says "line 14 is wrong" gets worked around, and one that says "use
 * `margin-inline-start`" gets fixed.
 */
const PHYSICAL_CSS: { pattern: RegExp; instead: string }[] = [
  { pattern: /\bmargin-left\s*:/, instead: 'margin-inline-start' },
  { pattern: /\bmargin-right\s*:/, instead: 'margin-inline-end' },
  { pattern: /\bpadding-left\s*:/, instead: 'padding-inline-start' },
  { pattern: /\bpadding-right\s*:/, instead: 'padding-inline-end' },
  { pattern: /\bborder-left\b/, instead: 'border-inline-start' },
  { pattern: /\bborder-right\b/, instead: 'border-inline-end' },
  { pattern: /\bborder-top-left-radius\s*:/, instead: 'border-start-start-radius' },
  { pattern: /\bborder-top-right-radius\s*:/, instead: 'border-start-end-radius' },
  { pattern: /\bborder-bottom-left-radius\s*:/, instead: 'border-end-start-radius' },
  { pattern: /\bborder-bottom-right-radius\s*:/, instead: 'border-end-end-radius' },
  { pattern: /(?<![-\w])left\s*:/, instead: 'inset-inline-start' },
  { pattern: /(?<![-\w])right\s*:/, instead: 'inset-inline-end' },
  { pattern: /\btext-align\s*:\s*(left|right)\b/, instead: 'text-align: start / end' },
  { pattern: /\bfloat\s*:\s*(left|right)\b/, instead: 'float: inline-start / inline-end' },
  { pattern: /\bclear\s*:\s*(left|right)\b/, instead: 'clear: inline-start / inline-end' },
  // Added in M2.1.1. These name a *physical axis* rather than a physical side, so they carry no
  // direction assumption — which is exactly why they need an allowlist with a reason rather than
  // a ban: the two the panel uses are legitimate and the next one probably is not.
  { pattern: /(?<![-\w])width\s*:/, instead: 'inline-size' },
  { pattern: /(?<![-\w])height\s*:/, instead: 'block-size' },
  { pattern: /\bmin-width\s*:/, instead: 'min-inline-size' },
  { pattern: /\bmax-width\s*:/, instead: 'max-inline-size' },
  { pattern: /\bmin-height\s*:/, instead: 'min-block-size' },
  { pattern: /\bmax-height\s*:/, instead: 'max-block-size' },
  { pattern: /\boverflow-x\s*:/, instead: 'overflow-inline' },
  { pattern: /\boverflow-y\s*:/, instead: 'overflow-block' },
];

/**
 * Physical properties are permitted only where the thing has a physical side, and every one is
 * listed here with its reason. An empty allowlist would be a rule nobody could follow; an
 * unexplained one is a rule that erodes.
 *
 * Keyed by `<file>:<property>` so an exemption cannot silently widen to a whole file.
 */
const PHYSICAL_ALLOWED = new Map<string, string>([
  // The two cases expected to need it eventually are a drop shadow's offset and an icon that
  // means "down"; both are physical facts about the thing rather than about the reading
  // direction. Neither has arrived. What has:
  [
    'styles/globals.css:overflow-inline',
    'M2.1.1: `overflow-x` on the table scroll region and on `.main`. A horizontal axis is ' +
      'symmetric under a direction change — an RTL document scrolls the same box the other way ' +
      'with no rule change — so the physical axis name carries no direction assumption. ' +
      '`overflow-inline` is the logical spelling and is too recent to make a browser release ' +
      'date a requirement of this panel.',
  ],
  [
    'styles/globals.css:inline-size',
    'M2.1.1: `width` on a `<col>` element. A table column\'s used width is the one thing the ' +
      'fixed table layout algorithm reads, and it is the property CSS 2.1 §17.5.2.1 names; ' +
      '`inline-size` computes to the same value but routes it through the logical-property ' +
      'alias, and a column that silently failed to take its width would divide the table into ' +
      'equal parts — the exact defect the fixed layout was adopted to fix.',
  ],
]);

// ── 2. Runtime CSS-in-JS ─────────────────────────────────────────────────────

/**
 * Packages that inject a `<style>` element or write a `style` attribute at runtime.
 *
 * Enforced against `package.json` as well as against imports, because the moment one of these
 * is a dependency somebody will use it. Not a judgement about the libraries — under this CSP
 * they simply do not work, and the failure is a silently unstyled page.
 */
const FORBIDDEN_PACKAGES = [
  'styled-components',
  '@emotion/react',
  '@emotion/styled',
  '@emotion/css',
  'emotion',
  'jss',
  'react-jss',
  'aphrodite',
  'glamor',
  'goober',
  'stitches',
  '@stitches/react',
  'styled-jsx',
  'linaria',
  '@vanilla-extract/dynamic',
];

// ── 3. Inline style, and data in a style prop ────────────────────────────────

const INLINE_STYLE_PATTERNS: { name: string; pattern: RegExp; instead: string }[] = [
  {
    name: 'style prop',
    pattern: /\bstyle\s*=\s*\{/,
    instead: "element.style.setProperty('--x', value) plus var(--x) in CSS",
  },
  {
    name: 'style attribute in markup',
    pattern: /\bstyle\s*=\s*["']/,
    instead: 'a class, or a custom property set through the CSSOM',
  },
  {
    name: 'style.cssText',
    pattern: /\.\s*style\s*\.\s*cssText\b/,
    instead: "setProperty, which style-src-attr does not block",
  },
  {
    name: "setAttribute('style')",
    pattern: /setAttribute\s*\(\s*['"]style['"]/,
    instead: "setProperty, which style-src-attr does not block",
  },
  {
    name: 'dangerouslySetInnerHTML',
    pattern: /dangerouslySetInnerHTML/,
    instead: 'text, because audit metadata and project names are attacker-influenced',
  },
];

function clientFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...clientFiles(full));
    else if (/\.(tsx?|css|html)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Strips a `//` comment, a `/* *​/` line, and a CSS comment line. */
function codeOf(line: string): string {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/^\s*\*.*$/, '')
    .replace(/\/\*.*?\*\//g, '');
}

describe('M2.1 — the client keeps to its own rules', () => {
  it('uses logical properties only, so direction is a setting rather than a rewrite', () => {
    const files = clientFiles(CLIENT_ROOT);
    expect(files.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(CLIENT_ROOT, file).split('\\').join('/');
      for (const [index, line] of readFileSync(file, 'utf-8').split('\n').entries()) {
        const code = codeOf(line);
        // A media condition is evaluated before custom properties are substituted and has no
        // logical spelling at all — `@media (inline-size: …)` is a container query, not a media
        // query. So `(max-width: 720px)` is a structural exception rather than an allowlisted one.
        if (/@media\b/.test(code)) continue;
        for (const { pattern, instead } of PHYSICAL_CSS) {
          if (!pattern.test(code)) continue;
          if (PHYSICAL_ALLOWED.has(`${rel}:${instead}`)) continue;
          offenders.push(`${rel}:${index + 1} use ${instead} — ${code.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('scans code that would fail it — the patterns are not vacuous', () => {
    // A rule enforced by a regex that cannot match is a rule that is not enforced. Every
    // pattern is driven against the shape it exists to catch.
    const samples: [RegExp, string][] = [
      [/\bmargin-left\s*:/, 'margin-left: 8px;'],
      [/(?<![-\w])left\s*:/, 'left: 0;'],
      [/\btext-align\s*:\s*(left|right)\b/, 'text-align: left;'],
      [/\bborder-left\b/, 'border-left: 1px solid var(--hairline);'],
      [/\bfloat\s*:\s*(left|right)\b/, 'float: right;'],
      [/(?<![-\w])width\s*:/, 'width: 100%;'],
      [/\bmax-width\s*:/, 'max-width: 76ch;'],
      [/\boverflow-x\s*:/, 'overflow-x: auto;'],
    ];
    for (const [pattern, sample] of samples) {
      expect(pattern.test(sample), sample).toBe(true);
    }
    // And the logical forms it must *not* catch, which is the other half: a scan that flagged
    // `margin-inline-start` would be worked around within a day.
    for (const { pattern } of PHYSICAL_CSS) {
      for (const good of [
        'margin-inline-start: var(--s2);',
        'padding-inline: var(--s3);',
        'inset-inline-start: 0;',
        'text-align: start;',
        'border-inline-start: 1px solid var(--hairline);',
        'border-start-start-radius: var(--radius);',
        'inline-size: 100%;',
        'max-inline-size: var(--measure-prose);',
        'min-block-size: 100vh;',
        'block-size: var(--gauge-h);',
      ]) {
        expect(pattern.test(good), `${pattern} matched ${good}`).toBe(false);
      }
    }
  });

  it('takes no runtime CSS-in-JS dependency, and imports none', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    for (const forbidden of FORBIDDEN_PACKAGES) {
      expect(declared.has(forbidden), `${forbidden} is a dependency`).toBe(false);
    }

    const offenders: string[] = [];
    for (const file of clientFiles(CLIENT_ROOT)) {
      const rel = relative(CLIENT_ROOT, file).split('\\').join('/');
      for (const [index, line] of readFileSync(file, 'utf-8').split('\n').entries()) {
        const code = codeOf(line);
        for (const forbidden of FORBIDDEN_PACKAGES) {
          if (new RegExp(`from\\s+['"]${forbidden.replace('/', '\\/')}`).test(code)) {
            offenders.push(`${rel}:${index + 1} imports ${forbidden}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('puts no value in a style prop, and no markup in a dangerous sink', () => {
    // The gauge in the resource widget is the component this decides. Under
    // `style-src 'self'` a `style` attribute is blocked outright, and the CSSOM path React uses
    // for `style={{}}` is *documented* as allowed but has historically been reported as a
    // violation by real browsers — so the one data-driven component in the panel does not rest
    // on it. `setProperty('--gauge-fill', …)` plus `var(--gauge-fill)` is the mechanism.
    const offenders: string[] = [];
    for (const file of clientFiles(CLIENT_ROOT)) {
      const rel = relative(CLIENT_ROOT, file).split('\\').join('/');
      for (const [index, line] of readFileSync(file, 'utf-8').split('\n').entries()) {
        const code = codeOf(line);
        for (const { name, pattern, instead } of INLINE_STYLE_PATTERNS) {
          if (pattern.test(code)) {
            offenders.push(`${rel}:${index + 1} ${name} — use ${instead}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('scans for inline style with patterns that are not vacuous', () => {
    const samples: Record<string, string> = {
      'style prop': 'return <div style={{ width: pct }} />;',
      'style attribute in markup': '<div style="width: 50%"></div>',
      'style.cssText': 'el.style.cssText = "width: 50%";',
      "setAttribute('style')": `el.setAttribute('style', 'width: 50%')`,
      dangerouslySetInnerHTML: '<div dangerouslySetInnerHTML={{ __html: meta }} />',
    };
    for (const { name, pattern } of INLINE_STYLE_PATTERNS) {
      expect(pattern.test(samples[name]!), name).toBe(true);
    }
    // `className` and a CSS custom property must not trip it.
    for (const { pattern } of INLINE_STYLE_PATTERNS) {
      expect(pattern.test('<div className="gauge" />')).toBe(false);
      expect(pattern.test("ref.current?.style.setProperty('--gauge-fill', pct)")).toBe(false);
    }
  });

  it('keeps the client out of the server, and the server out of the client', () => {
    // A client file that imported a server file would pull `node:fs` into a browser bundle;
    // the two tsconfigs make it a type error, and this makes it a test failure with a name.
    const offenders: string[] = [];
    for (const file of clientFiles(CLIENT_ROOT)) {
      const rel = relative(CLIENT_ROOT, file).split('\\').join('/');
      for (const [index, line] of readFileSync(file, 'utf-8').split('\n').entries()) {
        const code = codeOf(line);
        if (/from\s+['"][^'"]*server\//.test(code) || /from\s+['"]node:/.test(code)) {
          offenders.push(`${rel}:${index + 1} ${code.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
