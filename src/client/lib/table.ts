import type { TranslationKey } from '../i18n/en.js';

/**
 * What each table is made of, as data — so a column's width, its header and its content are one
 * declaration and cannot drift apart.
 *
 * ── Why this is a `.ts` file and not part of the component ──────────────────
 *
 * Two of the rules this milestone added are only enforceable over data. A test in this project
 * runs in Node with no DOM, so it cannot render a component; it *can* read a table's definition
 * and assert that every column has a width, that the width has a matching CSS rule, and that
 * every label the column can hold fits its character budget **in both languages**. That last one
 * is the check that matters: the reported defect was the "This device" pill broken onto two lines
 * inside its own border because the LEVEL column was narrower than the word, and the only way to
 * stop it happening again in Persian — a language the reviewer does not read — is a test.
 *
 * ── `table-layout: fixed` needs a complete colgroup, or it is worse than nothing ──
 *
 * A fixed layout divides the table's width equally between the columns that declare none, so a
 * partial colgroup is a table with some considered widths and some arbitrary ones. `<DataTable>`
 * renders the `<colgroup>` and the header row from *this* array, so they cannot disagree, and a
 * row supplies its cells as a record keyed by the same column keys — which makes a missing cell
 * a compile error rather than a short row.
 *
 * The column sizes are shared and named for what they hold rather than for a number, so a
 * timestamp column is the same width on every screen by construction.
 */

/** The character budget of each column size, in `ch` of the table's own font. */
export const COLUMN_CH = {
  /** The row expander: a chevron and nothing else. */
  expander: 4,
  /** A session's authentication level, plus the "this device" pill under it. */
  level: 16,
  /** A date and a time to the minute. */
  stamp: 24,
  /** A date and a time to the second, which only the audit log shows. */
  instant: 27,
  /** An audit event name: `two_factor.enrollment_started` is the longest at 29 characters. */
  event: 32,
  /** An outcome pill. */
  outcome: 12,
  /** A secret's scope, which becomes `project:<uuid>` in M2.2. */
  scope: 24,
  /** A key/value table's label column. */
  label: 22,
  /** One button. */
  action: 15,
  /**
   * The one column that takes what is left. Not a width: a **minimum**, which is what the
   * table's own `min-inline-size` is computed from. A percentage would resolve against a table
   * width that itself depends on these numbers.
   */
  flex: 25,
} as const;

export type ColumnSize = keyof typeof COLUMN_CH;

/**
 * The room a cell's padding takes out of its column, in the same `ch` units.
 *
 * `--s2` on each side at the table's font size, rounded up. It is part of the budget rather than
 * a fudge factor: the assertion is about what fits *inside* the cell.
 */
export const CELL_PADDING_CH = 3;

export interface Column<K extends TranslationKey = TranslationKey> {
  /** The dictionary key for the header, and the column's identity in a row's cells. */
  readonly key: K;
  readonly size: ColumnSize;
  /**
   * Every enumerated label that can appear in a cell of this column, so the budget can be
   * checked against all of them. Unbounded data — a user-agent string, a JSON blob — is not
   * listed and is not checkable; it is summarised (see `lib/user-agent.ts` and `lib/meta.ts`)
   * and the scroll region absorbs what a summary cannot.
   */
  readonly labels?: readonly TranslationKey[];
}

export interface TableSpec<K extends TranslationKey = TranslationKey> {
  /** Names the `.table-<name>` rule that carries the table's minimum width. */
  readonly name: string;
  /** The visually hidden `<caption>`, and the scroll region's accessible name. */
  readonly caption: TranslationKey;
  readonly columns: readonly Column<K>[];
  /** True to prepend the expander column and render a detail row under an expanded row. */
  readonly expandable: boolean;
}

/**
 * The table's minimum inline size: the sum of its columns, including the expander.
 *
 * This is what stops the character budgets from being decorative. With `table-layout: fixed` and
 * a table narrower than the sum of its declared widths, browsers scale the columns down to fit —
 * so without a minimum the budget is honoured only when there happens to be room, which is
 * exactly when it does not matter.
 */
export function tableMeasureCh(spec: TableSpec): number {
  const columns = spec.columns.reduce((total, column) => total + COLUMN_CH[column.size], 0);
  return columns + (spec.expandable ? COLUMN_CH.expander : 0);
}

export const SESSIONS_TABLE = {
  name: 'sessions',
  caption: 'sessions.title',
  expandable: true,
  columns: [
    {
      key: 'sessions.level',
      size: 'level',
      labels: ['sessions.levelFull', 'sessions.levelPre', 'sessions.current'],
    },
    { key: 'sessions.created', size: 'stamp' },
    { key: 'sessions.lastSeen', size: 'stamp' },
    { key: 'sessions.expires', size: 'stamp', labels: ['sessions.absolute'] },
    { key: 'sessions.userAgent', size: 'flex' },
    { key: 'sessions.revoke', size: 'action', labels: ['sessions.revoke', 'app.signOut'] },
  ],
} as const;

export const AUDIT_TABLE = {
  name: 'audit',
  caption: 'audit.title',
  expandable: true,
  columns: [
    { key: 'audit.when', size: 'instant' },
    { key: 'audit.event', size: 'event' },
    { key: 'audit.outcome', size: 'outcome' },
    { key: 'audit.meta', size: 'flex' },
  ],
} as const;

export const SECRETS_TABLE = {
  name: 'secrets',
  caption: 'secrets.title',
  expandable: false,
  columns: [
    { key: 'secrets.scope', size: 'scope' },
    { key: 'secrets.name', size: 'flex' },
    { key: 'secrets.updated', size: 'stamp' },
    { key: 'secrets.reveal', size: 'action', labels: ['secrets.reveal'] },
  ],
} as const;

/**
 * A key/value report is not a data table and does not pretend to be one: it has no header row,
 * its label column is a column of `<th scope="row">`, and its rows are pairs rather than records.
 * It shares the column sizes, the caption rule and the minimum-width rule, and nothing else.
 */
export interface KeyValueSpec {
  readonly name: string;
  readonly caption: TranslationKey;
  readonly labelSize: ColumnSize;
  /** Every label the first column can hold, for the character budget. */
  readonly labels: readonly TranslationKey[];
}

export function keyValueMeasureCh(spec: KeyValueSpec): number {
  return COLUMN_CH[spec.labelSize] + COLUMN_CH.flex;
}

export const TELEGRAM_TABLE: KeyValueSpec = {
  name: 'kv',
  caption: 'telegram.title',
  labelSize: 'label',
  labels: [
    'telegram.botToken',
    'telegram.chatId',
    'telegram.queue',
    'telegram.lastSuccess',
    'telegram.lastFailure',
  ],
};

/** Every table in the client, for the scans. A table that is not here is not asserted. */
export const ALL_TABLES: readonly TableSpec[] = [SESSIONS_TABLE, AUDIT_TABLE, SECRETS_TABLE];

export const ALL_KEY_VALUE_TABLES: readonly KeyValueSpec[] = [TELEGRAM_TABLE];

/** The cell keys each table's rows must supply. A missing one is a compile error. */
export type SessionColumnKey = (typeof SESSIONS_TABLE)['columns'][number]['key'];
export type AuditColumnKey = (typeof AUDIT_TABLE)['columns'][number]['key'];
export type SecretColumnKey = (typeof SECRETS_TABLE)['columns'][number]['key'];
