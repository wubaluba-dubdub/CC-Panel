import { describe, it, expect } from 'vitest';
import { en } from '../../src/client/i18n/en.js';
import fa from '../../src/client/i18n/fa.js';
import {
  ALL_KEY_VALUE_TABLES,
  ALL_TABLES,
  CELL_PADDING_CH,
  COLUMN_CH,
  keyValueMeasureCh,
  tableMeasureCh,
  type TableSpec,
} from '../../src/client/lib/table.js';
import { clientFiles, declarationsOf } from '../helpers/css.js';
import type { TranslationKey } from '../../src/client/i18n/en.js';

/**
 * The tables, asserted over their definitions.
 *
 * A test in this project runs in Node with no DOM, so it cannot render a component. It does not
 * need to: every rule this milestone added about a table is a rule about the *definition* it is
 * rendered from, and `components/Table.tsx` renders the `<colgroup>`, the header row and each
 * row's cells from that one array — the cells by a record keyed on the column keys, so a missing
 * cell is a compile error rather than something a test has to look for.
 *
 * What a test can see, and what would otherwise rot:
 *
 *  1. **A width for every column, and a CSS rule for every width.** `table-layout: fixed` with a
 *     partial colgroup is worse than an automatic layout: it divides the remaining width equally
 *     between the columns that were left out.
 *  2. **The table's minimum equals the sum of its columns.** Without it, a browser scales the
 *     declared widths down to fit and the character budgets hold only when there is room —
 *     which is exactly when they do not matter.
 *  3. **Every enumerated label fits its column, in both languages.** This is the one that had to
 *     exist: the reported defect was "This device" broken onto two lines inside its own pill
 *     because the level column was narrower than the phrase, and the reviewer of the Persian
 *     dictionary does not read Persian.
 */

const CSS = declarationsOf(clientFiles(/^globals\.css$/)[0]!);

/** `col.col-stamp { width: 24ch }` — the class name is the size, so the two cannot drift. */
function declaredColumnCh(size: string): number | null {
  const rule = CSS.find((decl) => decl.context.at(-1) === `col.col-${size}` && decl.property === 'width');
  if (rule === undefined) return null;
  return Number.parseInt(rule.value, 10);
}

function declaredTableMeasureCh(name: string): number | null {
  const rule = CSS.find(
    (decl) => decl.context.at(-1) === `.table-${name}` && decl.property === 'min-inline-size',
  );
  if (rule === undefined) return null;
  return Number.parseInt(rule.value, 10);
}

/** The visual width of a label, in the same `ch` the column is declared in. */
function widthOf(key: TranslationKey): number {
  return Math.max([...en[key]].length, [...fa[key]].length);
}

const SPECS: { name: string; caption: TranslationKey; sizes: string[]; measure: number }[] = [
  ...ALL_TABLES.map((spec: TableSpec) => ({
    name: spec.name,
    caption: spec.caption,
    sizes: [...(spec.expandable ? ['expander'] : []), ...spec.columns.map((column) => column.size)],
    measure: tableMeasureCh(spec),
  })),
  ...ALL_KEY_VALUE_TABLES.map((spec) => ({
    name: spec.name,
    caption: spec.caption,
    sizes: [spec.labelSize, 'flex'],
    measure: keyValueMeasureCh(spec),
  })),
];

describe('M2.1.1 — every table declares every column', () => {
  it('gives each column a size, and each size a CSS rule with the same number', () => {
    for (const spec of SPECS) {
      for (const size of spec.sizes) {
        if (size === 'flex') continue;
        expect(declaredColumnCh(size), `col.col-${size} has no width in globals.css`).toBe(
          COLUMN_CH[size as keyof typeof COLUMN_CH],
        );
      }
    }
    // The flexible column declares no width on purpose — the fixed layout gives it what is left.
    expect(
      CSS.some((decl) => decl.context.at(-1) === 'col.col-flex'),
      'col-flex declares something; it must declare nothing',
    ).toBe(false);
  });

  it('sets each table minimum to the sum of its columns', () => {
    for (const spec of SPECS) {
      expect(declaredTableMeasureCh(spec.name), `.table-${spec.name}`).toBe(spec.measure);
    }
  });

  it('names every column size that a table uses, and uses every one it names', () => {
    // A size nobody uses is a number nobody checks; a size used but unnamed cannot be budgeted.
    const used = new Set(SPECS.flatMap((spec) => spec.sizes));
    for (const size of Object.keys(COLUMN_CH)) {
      expect(used.has(size), `COLUMN_CH.${size} is not used by any table`).toBe(true);
    }
  });

  it("gives every table a caption, which is also its scroll region's name", () => {
    for (const spec of SPECS) {
      expect(en[spec.caption].trim()).not.toBe('');
      expect(fa[spec.caption].trim()).not.toBe('');
    }
  });
});

describe('M2.1.1 — every label fits its column, in both languages', () => {
  it('fits each header inside its own column', () => {
    const tooWide: string[] = [];
    for (const spec of ALL_TABLES) {
      for (const column of spec.columns) {
        if (column.size === 'flex') continue;
        const budget = COLUMN_CH[column.size] - CELL_PADDING_CH;
        if (widthOf(column.key) > budget) {
          tooWide.push(`${spec.name}: header ${column.key} is ${widthOf(column.key)} > ${budget}`);
        }
      }
    }
    expect(tooWide).toEqual([]);
  });

  it('fits every enumerated cell label inside its own column', () => {
    const tooWide: string[] = [];
    for (const spec of ALL_TABLES) {
      for (const column of spec.columns) {
        if (column.size === 'flex') continue;
        const budget = COLUMN_CH[column.size] - CELL_PADDING_CH;
        for (const label of column.labels ?? []) {
          if (widthOf(label) > budget) {
            tooWide.push(`${spec.name}/${column.key}: ${label} is ${widthOf(label)} > ${budget}`);
          }
        }
      }
    }
    expect(tooWide).toEqual([]);
  });

  it('fits every key/value label inside its label column', () => {
    const tooWide: string[] = [];
    for (const spec of ALL_KEY_VALUE_TABLES) {
      const budget = COLUMN_CH[spec.labelSize] - CELL_PADDING_CH;
      for (const label of spec.labels) {
        if (widthOf(label) > budget) {
          tooWide.push(`${spec.name}: ${label} is ${widthOf(label)} > ${budget}`);
        }
      }
    }
    expect(tooWide).toEqual([]);
  });

  it('is a budget that could fail — a longer label would be caught', () => {
    // The check is only worth having if it is tight enough to catch the defect it was written
    // for. `sessions.levelFull` is "Both factors", the widest label in the narrowest column.
    const budget = COLUMN_CH.level - CELL_PADDING_CH;
    expect(widthOf('sessions.levelFull')).toBeLessThanOrEqual(budget);
    expect(widthOf('sessions.levelFull') + 5).toBeGreaterThan(budget);
  });
});
