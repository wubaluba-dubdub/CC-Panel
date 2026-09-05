import { describe, it, expect } from 'vitest';
import { en, type TranslationKey } from '../../src/client/i18n/en.js';
import fa from '../../src/client/i18n/fa.js';
import {
  FSI,
  PDI,
  templateParts,
  translate,
  translateString,
} from '../../src/client/i18n/translate.js';

/**
 * The dictionaries, and the isolation rule the whole bidi design rests on.
 *
 * `fa.ts` is declared `const fa: Dict`, so a **missing** or misspelled key is already a
 * compile error and is not asserted here. What the type cannot see is asserted instead: that
 * no value is empty, that nothing is still the English string where it must not be, and that
 * every parameter a template names is actually isolated when it is filled in.
 */

const KEYS = Object.keys(en) as TranslationKey[];

/**
 * Keys whose Persian value is legitimately identical to the English one.
 *
 * A short list, on purpose. `common.english` is the word "English" in both, because a
 * language switch that translated its own labels would be a switch nobody could find in the
 * language they cannot read. Everything else has to differ.
 */
const SAME_IN_BOTH = new Set<TranslationKey>(['common.english', 'common.persian']);

describe('the dictionaries', () => {
  it('cover the same keys, which is what `const fa: Dict` already enforces at compile time', () => {
    // Belt for the braces: a future `fa` built with `as Dict` would satisfy the compiler and
    // fail here. That cast is exactly the shortcut somebody takes at 2am.
    expect(Object.keys(fa).sort()).toEqual(KEYS.slice().sort());
    expect(KEYS.length).toBeGreaterThan(100);
  });

  it('has no empty value in either language', () => {
    for (const key of KEYS) {
      expect(en[key].trim(), `en.${key}`).not.toBe('');
      expect(fa[key].trim(), `fa.${key}`).not.toBe('');
    }
  });

  it('is actually translated, rather than copied', () => {
    // The failure this catches is a key added to `en` and pasted into `fa` to make the
    // compiler happy — which ships an English sentence into a Persian interface and reads,
    // to the operator, as the panel being half-finished.
    for (const key of KEYS) {
      if (SAME_IN_BOTH.has(key)) continue;
      expect(fa[key], `fa.${key} is still the English string`).not.toBe(en[key]);
    }
  });

  it('names the same parameters in both languages', () => {
    // A Persian template that dropped `{count}` would render a sentence with a number
    // missing, and one that invented `{total}` would render the placeholder text. Neither is
    // visible to the type system, and both are invisible to a reviewer who does not read
    // Persian.
    const named = (template: string): string[] =>
      templateParts(template)
        .map((part) => part.name)
        .filter((name): name is string => name !== null)
        .sort();

    for (const key of KEYS) {
      expect(named(fa[key]), `fa.${key} parameters`).toEqual(named(en[key]));
    }
  });
});

describe('interpolation isolates every machine value', () => {
  it('returns a node, so a machine value cannot be concatenated into a string', () => {
    // The mechanism, stated as a test: `t()` with parameters is not a string, so
    // `t('x', {...}) + path` does not typecheck and `${t('x')}` renders `[object Object]`
    // rather than silently working.
    const node = translate('fa', 'app.signedInAs', { username: 'admin' });
    expect(typeof node).not.toBe('string');
  });

  it('wraps each parameter in a <bdi>, and leaves the literals alone', () => {
    const node = translate('en', 'resources.usedOfLimit', {
      used: '940 MB',
      limit: '1 GB',
    }) as { props: { children: unknown[] } };

    const children = node.props.children as unknown[];
    const bdis = children.filter(
      (child): child is { type: string; props: { children: unknown } } =>
        typeof child === 'object' && child !== null && (child as { type?: string }).type === 'bdi',
    );
    expect(bdis).toHaveLength(2);
    expect(bdis[0]!.props.children).toBe('940 MB');
    expect(bdis[1]!.props.children).toBe('1 GB');
    // And the literal text survives around them.
    expect(children.some((child) => child === ' of ')).toBe(true);
  });

  it('renders a missing parameter as its own placeholder rather than as undefined', () => {
    const node = translate('en', 'common.characters', {}) as { props: { children: unknown[] } };
    const children = node.props.children as { props?: { children?: unknown } }[];
    expect(children.some((child) => child?.props?.children === '{count}')).toBe(true);
  });

  it('isolates with FSI/PDI in the string form, because an attribute cannot hold an element', () => {
    // The one place the node form cannot be used — `aria-label`, `title`, `placeholder` — and
    // the hole is closed with the Unicode controls `<bdi>` is defined in terms of rather than
    // left as an exception.
    const text = translateString('fa', 'app.signedInAs', { username: 'admin' });
    expect(text).toContain(`${FSI}admin${PDI}`);
    expect(FSI).toBe('⁨');
    expect(PDI).toBe('⁩');
  });

  it('returns the template itself when there is nothing to interpolate', () => {
    expect(translate('en', 'login.title')).toBe(en['login.title']);
    expect(translateString('fa', 'login.title')).toBe(fa['login.title']);
  });
});
