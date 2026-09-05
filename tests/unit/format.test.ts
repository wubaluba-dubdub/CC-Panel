import { describe, it, expect } from 'vitest';
import {
  dateTimeFormatterConstructions,
  formatBytes,
  formatDuration,
  formatInstant,
  formatNumber,
  formatPercent,
  formatTechnical,
  instantParts,
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

describe('instants', () => {
  const iso = '2026-03-21T09:05:00.000Z';
  const september = '2026-09-05T20:24:18.123Z';

  it('gives an Iranian operator a Jalali date with Latin digits', () => {
    const technical = formatInstant(iso, 'fa')!;
    // Jalali: 21 March 2026 is in 1405, and the year is what proves the calendar is applied.
    expect(technical).toContain('1405');
    expect(technical).not.toMatch(/[۰-۹]/);
  });

  it('renders no date that can be read as two different days', () => {
    // The reported defect: `dateStyle: 'short'` renders 5 September 2026 as `05/09/2026`, which
    // is 5 May to a US reader, and both readings are internally consistent. A month token cannot
    // be misread, so the assertion is that no rendered date is all digits and separators.
    for (const locale of ['en', 'fa'] as const) {
      for (const precision of ['minute', 'second'] as const) {
        const rendered = formatInstant(september, locale, precision)!;
        expect(rendered, `${locale}/${precision}`).not.toMatch(/\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/);
        // And it carries a month token: at least three letters that are not the time.
        expect(rendered.replace(/[\d\s:,./]/g, '').length, `${locale}/${precision}`).toBeGreaterThan(2);
      }
    }
  });

  it('has exactly two precisions, and only the second one shows seconds', () => {
    const minute = formatInstant(september, 'en', 'minute')!;
    const second = formatInstant(september, 'en', 'second')!;
    expect(minute).toMatch(/\d{2}:\d{2}$/);
    expect(second).toMatch(/\d{2}:\d{2}:\d{2}$/);
    // Minutes is the default: every screen but the audit log gets it without asking.
    expect(formatInstant(september, 'en')).toBe(minute);
  });

  it('memoises one formatter per locale and precision', () => {
    // Constructing an `Intl.DateTimeFormat` is the expensive half of formatting one, and the
    // audit log renders a hundred rows. Four are possible; a hundred rows must not build a
    // hundred.
    const before = dateTimeFormatterConstructions();
    for (let index = 0; index < 100; index += 1) {
      formatInstant(september, 'en', 'second');
      formatInstant(september, 'fa', 'second');
      formatInstant(september, 'en', 'minute');
      formatInstant(september, 'fa', 'minute');
    }
    expect(dateTimeFormatterConstructions() - before).toBeLessThanOrEqual(4);
    // And the cache is shared across calls, so a second pass builds nothing at all.
    const warm = dateTimeFormatterConstructions();
    formatInstant(september, 'en', 'second');
    expect(dateTimeFormatterConstructions()).toBe(warm);
  });

  it('returns null rather than "Invalid Date" for anything unparseable', () => {
    // These come from a JSON body. A row whose timestamp is malformed must not render the
    // words "Invalid Date" in the middle of an audit table.
    expect(formatInstant(null, 'en')).toBeNull();
    expect(formatInstant(undefined, 'en')).toBeNull();
    expect(formatInstant('not a date', 'en')).toBeNull();
    expect(formatInstant('', 'fa')).toBeNull();
  });
});

describe('the exact instant, for correlating with a log line', () => {
  it('gives the local time with its offset and the same instant in UTC', () => {
    const parts = instantParts('2026-09-05T20:24:18.123Z')!;
    expect(parts.utc).toBe('2026-09-05T20:24:18.123Z');
    // Machine-readable, unlocalised, and always signed — the offset is the half that makes the
    // local time convertible.
    expect(parts.local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    // Both name the same instant, whatever zone the suite runs in. The local half is to the
    // second and the UTC half keeps its milliseconds: the operator reads their own clock and
    // pastes the UTC one, and a log line's millisecond is on the UTC side.
    expect(Date.parse(parts.local)).toBe(Math.floor(Date.parse(parts.utc) / 1000) * 1000);
  });

  it('is null for a value it cannot parse, like the formatter', () => {
    expect(instantParts(null)).toBeNull();
    expect(instantParts('not a date')).toBeNull();
  });
});
