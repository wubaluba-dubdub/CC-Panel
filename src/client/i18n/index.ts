import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { TranslationKey } from './en.js';
import { translate, translateString, type TranslationParams } from './translate.js';
import type { Locale } from '../../shared/types.js';

/**
 * The React half: the provider, the hook, and the two attributes that carry direction.
 *
 * The pure translation functions are in `i18n/translate.ts` — no DOM, no state — because the
 * bidi rules are the part worth testing and a function that needs a browser to test is a
 * function nobody checks. This file is what makes them available to a component tree and
 * keeps `<html lang>` and `<html dir>` in step with the choice.
 */
export type { Locale };
export type { TranslationParams };
export { translate, translateString };

export const LOCALES: readonly Locale[] = ['en', 'fa'];

/** Where the browser remembers an explicit choice. Read by `bootstrap.js` before paint. */
export const LOCALE_STORAGE_KEY = 'panel.locale';

export interface LocaleContextValue {
  locale: Locale;
  /** Sets the locale, applies it to `<html>`, and remembers it for the next boot. */
  setLocale: (next: Locale) => void;
  /** Returns a node. Parameters are `<bdi>`-isolated; see `i18n/translate.ts`. */
  t: (key: TranslationKey, params?: TranslationParams) => ReactNode;
  /** Returns a string, for attributes only. Parameters are isolated with FSI/PDI. */
  ts: (key: TranslationKey, params?: TranslationParams) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * The initial locale comes from `bootstrap.js`, never from React.
 *
 * That script is a blocking classic script in `<head>` and has already set
 * `documentElement.lang` and `dir` before this module is fetched — which is what makes "no
 * left-to-right flash on a Persian page" a structural property rather than a race React can
 * lose. This reads its answer; it does not decide it.
 */
export function initialLocale(): Locale {
  const fromWindow = window.__LOCALE__;
  return fromWindow === 'fa' || fromWindow === 'en' ? fromWindow : 'en';
}

export function LocaleProvider({ children }: { children: ReactNode }): ReactNode {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    // The same two attributes `bootstrap.js` set, kept in step. Done here rather than in an
    // effect so the direction changes in the same commit as the text.
    document.documentElement.lang = next;
    document.documentElement.dir = next === 'fa' ? 'rtl' : 'ltr';
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable in a partitioned context. The choice still applies to
      // this page; it just will not survive a reload, which is a smaller loss than throwing.
    }
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, params) => translate(locale, key, params),
      ts: (key, params) => translateString(locale, key, params),
    }),
    [locale, setLocale],
  );

  return createElement(LocaleContext.Provider, { value }, children);
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (value === null) {
    throw new Error('useLocale was called outside LocaleProvider');
  }
  return value;
}
