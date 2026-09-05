import { createElement, Fragment, type ReactNode } from 'react';
import { en, type Dict, type TranslationKey } from './en.js';
import fa from './fa.js';
import type { Locale } from '../../shared/types.js';

/**
 * The pure half of the translation layer: no DOM, no React state, no `window`.
 *
 * Split from `i18n/index.ts` so the suite can drive it directly. The provider needs
 * `document` and `localStorage`; this needs neither, and a translation function that cannot
 * be tested without a browser is a translation function nobody checks.
 */

export type TranslationParams = Record<string, string | number | ReactNode>;

const DICTS: Record<Locale, Dict> = { en, fa };

/** Splits a template into its literal and `{placeholder}` parts, in order. */
export function templateParts(template: string): { literal: string; name: string | null }[] {
  const out: { literal: string; name: string | null }[] = [];
  const pattern = /\{(\w+)\}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    out.push({ literal: template.slice(last, match.index), name: match[1]! });
    last = match.index + match[0].length;
  }
  out.push({ literal: template.slice(last), name: null });
  return out;
}

/**
 * Renders one key in one locale, as a **ReactNode and not a string**.
 *
 * That return type is the whole mechanism. A Latin value inside a Persian sentence reorders
 * visually unless it is isolated, because the neutral characters at its edges — `/` `.` `-`
 * `:` `(` — resolve to the *paragraph's* direction rather than the run's:
 *
 * ```
 * raw (stored, unchanged):      پروژه در {path} ذخیره شد
 * without isolation, displays:  … data/projects/9f8e/workspace/ …   ← the "/" jumped
 * with <bdi>, displays:         … /data/projects/9f8e/workspace …
 * ```
 *
 * The string on disk is identical in both cases; only the visual order differs, which is why
 * it reads as a data error and gets reported as one. It is the most common Persian-UI bug, so
 * it is not left to discipline: every parameter is wrapped in `<bdi>` here, and because the
 * return value is a node there is **no string to concatenate a machine value into**.
 *
 * A missing parameter renders as its own placeholder rather than as `undefined`: a caller
 * that forgot an argument is a bug to see, and `{count}` on screen is easy to trace.
 */
export function translate(
  locale: Locale,
  key: TranslationKey,
  params?: TranslationParams,
): ReactNode {
  const template = DICTS[locale][key];
  if (params === undefined) return template;

  const children: ReactNode[] = [];
  for (const [index, part] of templateParts(template).entries()) {
    if (part.literal !== '') children.push(part.literal);
    if (part.name === null) continue;
    const value = params[part.name];
    children.push(
      createElement(
        'bdi',
        { key: `${part.name}-${index}` },
        value === undefined ? `{${part.name}}` : (value as ReactNode),
      ),
    );
  }
  return createElement(Fragment, null, ...children);
}

/** U+2068 FIRST STRONG ISOLATE and U+2069 POP DIRECTIONAL ISOLATE. */
export const FSI = '⁨';
export const PDI = '⁩';

/**
 * The string form, for attribute contexts only.
 *
 * `aria-label`, `title`, `placeholder` and `document.title` take strings, so the node form
 * cannot be used there — and that is the one hole in "a machine value cannot be concatenated
 * raw". It is closed rather than accepted: parameters are wrapped in {@link FSI} and
 * {@link PDI}, the Unicode isolate controls that `<bdi>` is *defined in terms of*. The
 * isolation is identical; only the mechanism differs, because an attribute cannot hold an
 * element.
 */
export function translateString(
  locale: Locale,
  key: TranslationKey,
  params?: TranslationParams,
): string {
  const template = DICTS[locale][key];
  if (params === undefined) return template;
  return templateParts(template)
    .map((part) => {
      if (part.name === null) return part.literal;
      const value = params[part.name];
      const text = value === undefined ? `{${part.name}}` : String(value);
      return `${part.literal}${FSI}${text}${PDI}`;
    })
    .join('');
}

export { DICTS as dictionaries };
