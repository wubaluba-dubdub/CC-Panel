import type { Locale } from '../../shared/types.js';

/**
 * Every number, byte count and date the operator sees, in one file.
 *
 * ── Two formatters, and the distinction is load-bearing ─────────────────────
 *
 * | | Locale used | For |
 * | :--- | :--- | :--- |
 * | {@link formatNumber}, {@link formatDate} | `fa-IR` / `en-GB` | prose quantities and dates |
 * | {@link formatTechnical}, {@link formatTechnicalDate} | `fa-IR-u-ca-persian-nu-latn` | anything inside an LTR island |
 *
 * **Latin digits for every technical value in both languages.** `fa` defaults to `arabext`
 * numbering, so `Intl.NumberFormat('fa-IR').format(8080)` yields `۸۰۸۰`: a port number that
 * does not match the terminal, a byte count that will not `grep`, a commit id that is not the
 * commit id. `-nu-latn` is not cosmetic — it is what keeps a number the same number on both
 * sides of a clipboard. The Jalali *calendar* is kept (`-ca-persian`), because a date is read
 * rather than pasted, and an Iranian operator reading a Gregorian date has to convert it.
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

/** An ISO-8601 instant as a date and time, in the operator's calendar. */
export function formatDate(iso: string | null, locale: Locale): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat(PROSE_LOCALE[locale], {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}

/** The same instant for an LTR island: Jalali where it applies, Latin digits always. */
export function formatTechnicalDate(iso: string | null, locale: Locale): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat(TECHNICAL_LOCALE[locale], {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(ms));
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
