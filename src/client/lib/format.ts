import type { Locale } from '../../shared/types.js';

/**
 * Every number, byte count and instant the operator sees, in one file.
 *
 * ── Two number formatters, and the distinction is load-bearing ───────────────
 *
 * | | Locale used | For |
 * | :--- | :--- | :--- |
 * | {@link formatNumber} | `fa-IR` / `en-GB` | a quantity inside a sentence |
 * | {@link formatTechnical}, {@link formatBytes}, {@link formatPercent}, {@link formatInstant} | `fa-IR-u-ca-persian-nu-latn` | anything inside an LTR island |
 *
 * **Latin digits for every technical value in both languages.** `fa` defaults to `arabext`
 * numbering, so `Intl.NumberFormat('fa-IR').format(8080)` yields `۸۰۸۰`: a port number that
 * does not match the terminal, a byte count that will not `grep`, a commit id that is not the
 * commit id. `-nu-latn` is not cosmetic — it is what keeps a number the same number on both
 * sides of a clipboard. The Jalali *calendar* is kept (`-ca-persian`), because a date is read
 * rather than pasted.
 *
 * ── One instant formatter, and it is the only `Intl.DateTimeFormat` in the client ──
 *
 * `tests/integration/client-style.test.ts` asserts that. Three decisions in it:
 *
 * 1. **A month token, never a numeric month.** `dateStyle: 'short'` renders 5 September 2026 as
 *    `05/09/2026`, which is 5 May to a US reader — and the screen this was reported from showed
 *    `05/09/2026` and `05/10/2026` together, where the ambiguity is worse rather than better,
 *    because either reading is internally consistent. No rendered date may be readable as two
 *    different days.
 * 2. **Two precisions and no others.** Minutes everywhere, seconds in the audit log, where the
 *    order of two rows inside one minute is information. A hard expiry thirty days away does not
 *    carry a meaningful second, and showing one invites the reader to trust it.
 * 3. **The exact instant is always one hover away**, in a `title` — the local time with its UTC
 *    offset and the same instant in UTC, so any value on this screen can be lined up with a
 *    Railway log line, which is in UTC. See {@link instantParts}.
 *
 * The formatters are **memoised per locale and precision**. Constructing an
 * `Intl.DateTimeFormat` is the expensive part of formatting one, and the audit log renders a
 * hundred rows; `tests/unit/format.test.ts` asserts the construction count rather than trusting
 * the comment.
 */

const PROSE_LOCALE: Record<Locale, string> = { en: 'en-GB', fa: 'fa-IR' };

/** Jalali calendar, Latin digits. Used for everything in a `dir="ltr"` island. */
const TECHNICAL_LOCALE: Record<Locale, string> = { en: 'en-GB', fa: 'fa-IR-u-ca-persian-nu-latn' };

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(PROSE_LOCALE[locale]).format(value);
}

export function formatTechnical(value: number, locale: Locale): string {
  return new Intl.NumberFormat(TECHNICAL_LOCALE[locale], { useGrouping: false }).format(value);
}

/**
 * Bytes, on the **decimal** basis the platform bills in.
 *
 * 1 GB is 1 000 000 000 bytes here, not 1 073 741 824. That is a deliberate choice against
 * the more technically familiar one: the operator's Railway plan is quoted in GB, and a panel
 * that renders a 1 GB limit as "0.93 GiB" is telling them their plan is smaller than they
 * bought. `memory.max` is in bytes either way; only the division changes.
 *
 * Null is **not zero and not an error**. `limitBytes: null` means *no limit reported*, and
 * this returns null so the caller has to decide what that says — see
 * `resources.noLimit` in the dictionary. A `0 B` there would render as a full bar.
 */
const UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(bytes: number | null, locale: Locale): string | null {
  if (bytes === null || !Number.isFinite(bytes)) return null;
  if (bytes < 1000) return `${formatTechnical(Math.max(0, Math.round(bytes)), locale)} B`;

  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  // One decimal below 10, none above: "1.5 GB" is useful and "940.3 MB" is noise. The
  // rounding is done before formatting so the digits are the platform's, not the locale's.
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${new Intl.NumberFormat(TECHNICAL_LOCALE[locale], {
    maximumFractionDigits: 1,
    useGrouping: false,
  }).format(rounded)} ${UNITS[unit]}`;
}

/** A percentage, one decimal, always with the sign the locale writes. */
export function formatPercent(fraction: number | null, locale: Locale): string | null {
  if (fraction === null || !Number.isFinite(fraction)) return null;
  return new Intl.NumberFormat(TECHNICAL_LOCALE[locale], {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(fraction);
}

/** Minutes everywhere; seconds only in the audit log. */
export type InstantPrecision = 'minute' | 'second';

const INSTANT_OPTIONS: Record<InstantPrecision, Intl.DateTimeFormatOptions> = {
  // `month: 'short'` is the whole point: a name cannot be read as another month, and a
  // day-before-month locale and a month-before-day one then agree about the day.
  minute: {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  },
  second: {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  },
};

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

let constructions = 0;

/**
 * How many `Intl.DateTimeFormat` objects this module has built.
 *
 * Exported for the suite, because "memoised" is a claim about behaviour that a comment cannot
 * keep true: there are four possible formatters (two locales, two precisions) and a hundred-row
 * audit page must not build a hundred of them.
 */
export function dateTimeFormatterConstructions(): number {
  return constructions;
}

function formatterFor(locale: Locale, precision: InstantPrecision): Intl.DateTimeFormat {
  const cacheKey = `${locale}:${precision}`;
  const cached = FORMATTERS.get(cacheKey);
  if (cached !== undefined) return cached;
  const made = new Intl.DateTimeFormat(TECHNICAL_LOCALE[locale], INSTANT_OPTIONS[precision]);
  constructions += 1;
  FORMATTERS.set(cacheKey, made);
  return made;
}

/**
 * An ISO-8601 instant, in the operator's calendar and always with a month name.
 *
 * Null for a missing or unparseable value rather than a fabricated date: the caller renders the
 * em dash, because "no value" and "the epoch" must not look the same.
 */
export function formatInstant(
  iso: string | null | undefined,
  locale: Locale,
  precision: InstantPrecision = 'minute',
): string | null {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return formatterFor(locale, precision).format(new Date(ms));
}

function pad(value: number): string {
  return String(Math.floor(Math.abs(value))).padStart(2, '0');
}

/**
 * The same instant twice: local with its UTC offset, and UTC.
 *
 * This is what makes a timestamp on the screen usable as evidence. The panel's log lines are in
 * UTC (Railway's are too), the operator's screen is in their own zone, and a value that cannot be
 * converted between the two is a value they cannot correlate. Built by hand rather than with a
 * formatter, because the point is a machine-readable form and not a localised one.
 */
export function instantParts(iso: string | null | undefined): { local: string; utc: string } | null {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const offset = `${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`;
  const local =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
  return { local, utc: date.toISOString() };
}

/**
 * A duration, for "expires in" and "nothing delivered for".
 *
 * `Intl.RelativeTimeFormat` would say "in 4 minutes", which is right for a timestamp and
 * wrong for a countdown that is being watched — the TOTP window is five minutes and the
 * operator wants to see it move. So: the largest two units, and seconds when it is under a
 * minute.
 */
export function formatDuration(ms: number, locale: Locale): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const n = (value: number): string => formatTechnical(value, locale);
  if (total < 60) return `${n(total)}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s === 0 ? `${n(m)}m` : `${n(m)}m ${n(s)}s`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return m === 0 ? `${n(h)}h` : `${n(h)}h ${n(m)}m`;
}
