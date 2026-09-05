import { Mono } from './components/Ltr.js';
import { LOCALES, useLocale } from './i18n/index.js';

/**
 * Part 2's client: the same proof as Part 1, plus the whole translation and direction path.
 *
 * Still deliberately small. What it demonstrates is everything a screen needs and nothing a
 * screen is: a translated string, a translated string with an isolated machine value in it, an
 * LTR island, and a language switch that flips `<html dir>` live. Parts 3 and 4 replace this
 * with the router and the real screens.
 */
export function App(): React.JSX.Element {
  const { locale, setLocale, t } = useLocale();
  const base = window.__BASE__ ?? '(missing)';

  return (
    <main className="boot">
      <h1>{t('app.name')}</h1>
      <p>{t('app.signedInAs', { username: 'nobody yet' })}</p>
      <p>
        base path: <Mono>{base}</Mono>
      </p>
      <p>
        {/* A radio group rather than a select: two options, and the label of each has to be
            legible to somebody who cannot read the other one. */}
        <span id="locale-label">{t('common.language')}</span>
      </p>
      <div role="radiogroup" aria-labelledby="locale-label">
        {LOCALES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="radio"
            aria-checked={locale === candidate}
            className={locale === candidate ? 'chip chip-on' : 'chip'}
            onClick={() => setLocale(candidate)}
          >
            {candidate === 'en' ? t('common.english') : t('common.persian')}
          </button>
        ))}
      </div>
    </main>
  );
}
