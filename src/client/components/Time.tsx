import { useLocale } from '../i18n/index.js';
import { formatInstant, instantParts, type InstantPrecision } from '../lib/format.js';

/**
 * A timestamp: a real `<time>` element, in the mono face, that never wraps and always carries the
 * exact instant.
 *
 * Four things it settles, each of which was a reported defect or a decision the screens were
 * making one at a time:
 *
 * 1. **It never wraps.** `05/09/2026,` on one line and `23:24:18` on the next was reported from a
 *    real screen. `white-space: nowrap` is safe here rather than clipping, because the column's
 *    character budget is asserted against what this renders — see `lib/table.ts`.
 * 2. **It is monospaced**, which makes the tabular-figures question moot by construction: a
 *    monospaced face has one advance per glyph, so a polled value cannot change width as its
 *    digits change. That is measured rather than assumed — Vazirmatn's Latin subset ships no
 *    `tnum` feature, so `font-variant-numeric: tabular-nums` in the UI face would have been a
 *    silent no-op. See `docs/UI.md` §*Numbers and dates*.
 * 3. **It is an LTR island.** A date with Latin digits inside a Persian sentence reorders at its
 *    edges otherwise, which reads as data corruption rather than as a layout setting.
 * 4. **It carries the exact instant in a `title`** — local with the UTC offset, and UTC — so any
 *    value on the screen can be lined up with a log line. That attribute is a string context, so
 *    it goes through `ts()`, which isolates each parameter with U+2068/U+2069 rather than with a
 *    `<bdi>` element an attribute cannot hold.
 *
 * A missing or unparseable value renders an em dash. Not the epoch, and not an empty cell: "there
 * is no value here" is information.
 */
export function Time({
  iso,
  precision = 'minute',
}: {
  iso: string | null | undefined;
  precision?: InstantPrecision;
}): React.JSX.Element {
  const { locale, ts } = useLocale();
  const text = formatInstant(iso, locale, precision);
  const parts = instantParts(iso);

  if (text === null || iso === null || iso === undefined) {
    return (
      <span dir="ltr" className="ltr mono nowrap">
        —
      </span>
    );
  }

  return (
    <time
      dir="ltr"
      className="ltr mono nowrap"
      dateTime={iso}
      {...(parts === null ? {} : { title: ts('time.exact', parts) })}
    >
      {text}
    </time>
  );
}
