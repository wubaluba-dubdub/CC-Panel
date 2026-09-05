import { useCallback, useState, type ReactNode } from 'react';
import { useLocale } from '../i18n/index.js';
import { ScrollRegion } from './ui.js';
import type { TranslationKey } from '../i18n/en.js';
import type { KeyValueSpec, TableSpec } from '../lib/table.js';

/**
 * The one table primitive. Every table in the panel is this component or its key/value sibling,
 * and `tests/integration/client-style.test.ts` asserts that no other file renders a `<table>`.
 *
 * ── What it fixes, and why it is a primitive rather than a fix per screen ────
 *
 * Both tables in M2.1 were laid out by `table-layout: auto`, so their width was the sum of their
 * widest cells — and their widest cells held a raw user-agent string and a JSON blob. The card
 * around them neither clipped nor scrolled. The result was a table drawn across its card's
 * border and its rounded corner: the sessions list's last column and every row's divider, and
 * about 350 pixels of the audit log's metadata sitting on the page background.
 *
 * Five properties, all of them here rather than on a screen:
 *
 * 1. **`table-layout: fixed` with a complete `<colgroup>`.** Both the columns and the header row
 *    are rendered from `spec.columns`, so they cannot disagree — and a fixed layout with a
 *    *partial* colgroup is worse than an automatic one, because it divides the remaining width
 *    equally between whatever was left out.
 * 2. **A row's cells are a record keyed by the column keys**, so a missing cell is a compile
 *    error rather than a short row. This is the strongest form of the "colgroup declares as many
 *    columns as the header has cells" rule: the two come from one array and the cells are checked
 *    against it by the type system.
 * 3. **A visually hidden `<caption>`** names the table for a screen reader without drawing a
 *    title above it, and the same string names the scroll region.
 * 4. **The header is sticky inside the scroll region**, painted with the surface token so rows
 *    scroll under it rather than through it.
 * 5. **One row expander**, shared by both tables. Its detail row spans every column, is mounted
 *    only while open — so `aria-controls` never names an element that is not there — and reveals
 *    with opacity. Not with height: a height transition on a table row is a reflow per frame, on
 *    a panel that is polling every two seconds.
 */

export interface DataRow<K extends TranslationKey> {
  /** Stable across a poll, because it keys the row and the detail row's id. */
  id: string | number;
  cells: Record<K, ReactNode>;
  /** Shown in a row under this one while the expander is open. */
  detail?: ReactNode;
}

/** How many skeleton rows stand in for a table that has not loaded. */
const SKELETON_ROWS = 3;

export function DataTable<K extends TranslationKey>({
  spec,
  rows,
  empty,
  loading = false,
}: {
  spec: TableSpec<K>;
  rows: readonly DataRow<NoInfer<K>>[];
  /** Shown in place of the rows when there are none. The header stays. */
  empty?: ReactNode;
  loading?: boolean;
}): React.JSX.Element {
  const { t, ts } = useLocale();
  const [expanded, setExpanded] = useState<readonly (string | number)[]>([]);

  const toggle = useCallback((id: string | number) => {
    setExpanded((open) => (open.includes(id) ? open.filter((one) => one !== id) : [...open, id]));
  }, []);

  const span = spec.columns.length + (spec.expandable ? 1 : 0);

  return (
    <ScrollRegion label={ts(spec.caption)}>
      <table className={`table table-${spec.name}`}>
        <caption className="visually-hidden">{t(spec.caption)}</caption>
        <colgroup>
          {spec.expandable ? <col className="col-expander" /> : null}
          {spec.columns.map((column) => (
            <col key={column.key} className={`col-${column.size}`} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {spec.expandable ? (
              <th scope="col">
                <span className="visually-hidden">{t('table.expand')}</span>
              </th>
            ) : null}
            {spec.columns.map((column) => (
              <th scope="col" key={column.key}>
                {t(column.key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <SkeletonRows span={span} />
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={span}>{empty}</td>
            </tr>
          ) : (
            rows.map((row) => {
              const open = expanded.includes(row.id);
              const detailId = `${spec.name}-detail-${row.id}`;
              return (
                <Row
                  key={row.id}
                  row={row}
                  spec={spec}
                  open={open}
                  detailId={detailId}
                  span={span}
                  onToggle={toggle}
                />
              );
            })
          )}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

function Row<K extends TranslationKey>({
  row,
  spec,
  open,
  detailId,
  span,
  onToggle,
}: {
  row: DataRow<K>;
  spec: TableSpec<K>;
  open: boolean;
  detailId: string;
  span: number;
  onToggle: (id: string | number) => void;
}): React.JSX.Element {
  const { t } = useLocale();
  return (
    <>
      <tr>
        {spec.expandable ? (
          <td>
            {row.detail === undefined ? null : (
              <button
                type="button"
                className="expander"
                aria-expanded={open}
                {...(open ? { 'aria-controls': detailId } : {})}
                onClick={() => onToggle(row.id)}
              >
                {/* The chevron points down when closed and up when open, which needs no
                    mirroring: a horizontal disclosure arrow would have to flip with the
                    document's direction, and a rotation is a physical transform. */}
                <span className="chevron" aria-hidden="true" />
                <span className="visually-hidden">
                  {t(open ? 'table.collapse' : 'table.expand')}
                </span>
              </button>
            )}
          </td>
        ) : null}
        {spec.columns.map((column) => (
          <td key={column.key}>{row.cells[column.key]}</td>
        ))}
      </tr>
      {open && row.detail !== undefined ? (
        <tr className="detail-row" id={detailId}>
          <td colSpan={span}>{row.detail}</td>
        </tr>
      ) : null}
    </>
  );
}

function SkeletonRows({ span }: { span: number }): React.JSX.Element {
  const { t } = useLocale();
  return (
    <>
      <tr>
        <td colSpan={span}>
          <span className="visually-hidden" role="status">
            {t('common.loading')}
          </span>
          <span className="skeleton" aria-hidden="true" />
        </td>
      </tr>
      {Array.from({ length: SKELETON_ROWS - 1 }, (_, index) => (
        <tr key={index} aria-hidden="true">
          <td colSpan={span}>
            <span className="skeleton" />
          </td>
        </tr>
      ))}
    </>
  );
}

/**
 * A label and a value, per row.
 *
 * Not a `<DataTable>` with two columns: the label column is a column of `<th scope="row">`, which
 * is what tells a screen reader that the value in the second cell belongs to the word in the
 * first. It shares the column sizes, the caption and the minimum width, and nothing else.
 */
export function KeyValueTable({
  spec,
  rows,
}: {
  spec: KeyValueSpec;
  rows: readonly { key: string; label: ReactNode; value: ReactNode }[];
}): React.JSX.Element {
  const { t, ts } = useLocale();
  return (
    <ScrollRegion label={ts(spec.caption)}>
      <table className={`table table-${spec.name}`}>
        <caption className="visually-hidden">{t(spec.caption)}</caption>
        <colgroup>
          <col className={`col-${spec.labelSize}`} />
          <col className="col-flex" />
        </colgroup>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
