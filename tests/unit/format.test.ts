import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  formatDate,
  formatDuration,
  formatNumber,
  formatPercent,
  formatTechnical,
  formatTechnicalDate,
} from '../../src/client/lib/format.js';

/**
 * Formatting, and the two decisions in it that are not cosmetic.
 *
 * **Latin digits for every technical value in both languages.** `Intl.NumberFormat('fa-IR')`
 * defaults to `arabext` numbering, which turns a port into `۸۰۸۰`, a byte count into
 * something that will not `grep`, and a commit id into not-the-commit-id. The operator reads
 * these to compare them with a terminal and to paste them.
 *
 * **Bytes on the decimal basis the platform bills in.** 1 GB is 1 000 000 000 here. Railway
 * quotes the plan in GB, and rendering a 1 GB limit as "0.93 GiB" tells the operator their
 * plan is smaller than they bought.
 */

describe('numbers', () => {
  it('uses Latin digits in Persian for technical values, and Persian digits in prose', () => {
    expect(formatTechnical(8080, 'fa')).toBe('8080');
    expect(formatTechnical(8080, 'en')).toBe('8080');
    // Prose is the other way round, deliberately: a count in a sentence is read, not pasted.
    expect(formatNumber(8080, 'fa')).toMatch(/[۰-۹]/);
    expect(formatNumber(8080, 'en')).toBe('8,080');
  });

  it('does not group digits in a technical value', () => {
    // `1 048 576` in a byte count is three tokens a double-click will not select.
    expect(formatTechnical(1048576, 'en')).toBe('1048576');
  });
});

describe('bytes', () => {
  it('formats the boundaries', () => {
    expect(formatBytes(0, 'en')).toBe('0 B');
    expect(formatBytes(999, 'en')).toBe('999 B');
    // 1000 is the boundary, because the basis is decimal.
    expect(formatBytes(1000, 'en')).toBe('1 kB');
    expect(formatBytes(1023, 'en')).toBe('1 kB');
    expect(formatBytes(1024, 'en')).toBe('1 kB');
    // Null is neither zero nor an error: `limitBytes: null` means *no limit reported*, and a
    // `0 B` there would render as a full bar.
    expect(formatBytes(null, 'en')).toBeNull();
  });

  it('renders the figure the operator asked to see', () => {
    // "940 MB / 1 GB" was the request, and this is the half of it that is a number.
    expect(formatBytes(940_000_000, 'en')).toBe('940 MB');
    expect(formatBytes(1_000_000_000, 'en')).toBe('1 GB');
    // One decimal below ten, none above: "1.5 GB" is useful and "940.3 MB" is noise.
    expect(formatBytes(1_500_000_000, 'en')).toBe('1.5 GB');
    expect(formatBytes(12_300_000_000, 'en')).toBe('12 GB');
  });

  it('uses Latin digits in Persian, and the same unit names', () => {
    // A byte count is a technical value on both sides of the clipboard.
    expect(formatBytes(940_000_000, 'fa')).toBe('940 MB');
    expect(formatBytes(1_500_000_000, 'fa')).toBe('1.5 GB');
  });

  it('is total, so a garbage figure cannot take the widget down', () => {
    expect(formatBytes(Number.NaN, 'en')).toBeNull();
    expect(formatBytes(Number.POSITIVE_INFINITY, 'en')).toBeNull();
    expect(formatBytes(-1, 'en')).toBe('0 B');
  });
});

describe('percentages and durations', () => {
  it('formats a fraction as a percentage with one decimal', () => {
    expect(formatPercent(0.5, 'en')).toBe('50%');
    expect(formatPercent(0.917, 'en')).toBe('91.7%');
    // Null is *not computable yet* — a CPU rate needs two samples — and must not render as 0.
    expect(formatPercent(null, 'en')).toBeNull();
  });

  it('counts down in the units a watched countdown needs', () => {
    // `Intl.RelativeTimeFormat` would say "in 4 minutes", which is right for a timestamp and
    // wrong for the five-minute TOTP window the operator is watching move.
    expect(formatDuration(45_000, 'en')).toBe('45s');
    expect(formatDuration(299_000, 'en')).toBe('4m 59s');
    expect(formatDuration(300_000, 'en')).toBe('5m');
    expect(formatDuration(3_600_000, 'en')).toBe('1h');
    expect(formatDuration(5_400_000, 'en')).toBe('1h 30m');
    expect(formatDuration(-1, 'en')).toBe('0s');
    // Latin digits in Persian, like every other technical figure.
    expect(formatDuration(45_000, 'fa')).toBe('45s');
  });
});

describe('dates', () => {
  const iso = '2026-03-21T09:05:00.000Z';

  it('gives an Iranian operator a Jalali date with Latin digits in a technical context', () => {
    const technical = formatTechnicalDate(iso, 'fa')!;
    // Jalali: 21 March 2026 is in 1405, and the year is what proves the calendar is applied.
    expect(technical).toContain('1405');
    expect(technical).not.toMatch(/[۰-۹]/);
  });

  it('uses the locale own digits in prose', () => {
    expect(formatDate(iso, 'fa')!).toMatch(/[۰-۹]/);
    expect(formatDate(iso, 'en')).toContain('2026');
  });

  it('returns null rather than "Invalid Date" for anything unparseable', () => {
    // These come from a JSON body. A row whose timestamp is malformed must not render the
    // words "Invalid Date" in the middle of an audit table.
    expect(formatDate(null, 'en')).toBeNull();
    expect(formatDate('not a date', 'en')).toBeNull();
    expect(formatTechnicalDate('', 'fa')).toBeNull();
  });
});
