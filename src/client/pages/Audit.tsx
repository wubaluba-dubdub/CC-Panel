import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, CopyButton, Notice } from '../components/ui.js';
import { DataTable, type DataRow } from '../components/Table.js';
import { Mono, MonoBlock } from '../components/Ltr.js';
import { Time } from '../components/Time.js';
import { useLocale } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { META_INLINE_PAIRS, metaPairs, rawMeta, type MetaPair } from '../lib/meta.js';
import { AUDIT_TABLE, type AuditColumnKey } from '../lib/table.js';
import type { AuditEntryView, AuditPageResponse, AuditVerifyResponse } from '../../shared/types.js';

/**
 * The audit log, and the one question it exists to answer.
 *
 * ── Metadata is text, and never anything that interprets markup ─────────────
 *
 * A row's `meta` carries values recorded from attacker-influenced input — a user-agent string, a
 * secret's name, a path. It is rendered as **text**, never as anything that interprets markup;
 * `dangerouslySetInnerHTML` is an eslint error in this project and a static-scan failure, which
 * is what keeps that true when a later screen wants "nicer" formatting.
 *
 * It is rendered as *pairs* rather than as `JSON.stringify(meta)`, which is what used to put
 * about 350 pixels of JSON outside the card and onto the page background. `lib/meta.ts` caps
 * every value; the keys stay untranslated because they are grep keys — the `sessionId` on this
 * screen has to be the `sessionId` in a Telegram message and in a Railway log line — and the
 * exact stored JSON is in the row's detail with a copy button, because that is the string an
 * operator compares against a backup.
 *
 * ── The verdict, and the honest caveat ──────────────────────────────────────
 *
 * `GET /api/audit/verify` walks the whole table and reports the first break. A failure means a
 * row was changed, removed or added by something other than this panel — and the screen also says
 * the thing that stops the alarm from being ignored: **a break at the oldest surviving row looks
 * identical to a changed `PANEL_MASTER_KEY`**, because the row hashes are keyed, so a different
 * key invalidates every row at once while a tamper leaves everything before the edited row
 * intact. The server sends that as a `hint` rather than as prose.
 */
export function Audit(): React.JSX.Element {
  const { t } = useLocale();
  const [entries, setEntries] = useState<AuditEntryView[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [end, setEnd] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<React.ReactNode | null>(null);
  const [verdict, setVerdict] = useState<AuditVerifyResponse | null>(null);

  const load = useCallback(
    async (from: number | null, event: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const query = new URLSearchParams({ limit: '50' });
        if (from !== null) query.set('cursor', String(from));
        if (event !== '') query.set('event', event);
        const page = await api.get<AuditPageResponse>(`/api/audit?${query.toString()}`);
        setEntries((previous) => (from === null ? page.entries : [...previous, ...page.entries]));
        setCursor(page.nextCursor);
        setEnd(page.nextCursor === null);
      } catch {
        setError(t('error.network'));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void load(null, filter);
  }, [load, filter]);

  const verify = async (): Promise<void> => {
    setBusy(true);
    try {
      setVerdict(await api.get<AuditVerifyResponse>('/api/audit/verify'));
    } catch {
      setError(t('error.network'));
    } finally {
      setBusy(false);
    }
  };

  /** The events actually present, so the filter cannot offer one that returns nothing. */
  const events = [...new Set(entries.map((entry) => entry.event))].sort();

  const rows: DataRow<AuditColumnKey>[] = entries.map((entry) => {
    const pairs = metaPairs(entry.meta);
    const raw = rawMeta(entry.meta);
    return {
      id: entry.id,
      cells: {
        // The one place seconds are shown: the order of two rows inside one minute is
        // information here, and nowhere else in the panel is it.
        'audit.when': <Time iso={entry.ts} precision="second" />,
        // The event name is a code from `AuditEvent`, shown as-is: translating a hundred event
        // names would be a hundred strings that have to stay in step with the server's enum, and
        // the operator greps for these.
        'audit.event': <Mono>{entry.event}</Mono>,
        'audit.outcome': (
          <Badge kind={entry.outcome === 'success' ? 'ok' : 'danger'}>{entry.outcome}</Badge>
        ),
        'audit.meta': (
          <>
            <Pairs pairs={pairs.slice(0, META_INLINE_PAIRS)} />
            {pairs.length > META_INLINE_PAIRS ? (
              <span className="hint">
                {t('table.more', { count: pairs.length - META_INLINE_PAIRS })}
              </span>
            ) : null}
          </>
        ),
      },
      ...(pairs.length === 0
        ? {}
        : {
            detail: (
              <>
                {pairs.length > META_INLINE_PAIRS ? (
                  <Pairs pairs={pairs.slice(META_INLINE_PAIRS)} />
                ) : null}
                <p className="hint">{t('audit.metaRaw')}</p>
                <MonoBlock>{raw}</MonoBlock>
                <div className="row">
                  <CopyButton value={raw} />
                </div>
              </>
            ),
          }),
    };
  });

  return (
    <>
      <h1>{t('audit.title')}</h1>
      <p className="lede">{t('audit.explain')}</p>

      {error === null ? null : <Notice kind="danger">{error}</Notice>}

      <Card title={t('audit.verify')}>
        <div className="row">
          <Button onClick={() => void verify()} busy={busy}>
            {t('audit.verify')}
          </Button>
          {verdict === null ? null : (
            <Badge kind={verdict.ok ? 'ok' : 'danger'}>
              {verdict.ok
                ? t('audit.verifyOk', { count: <Mono>{verdict.checked}</Mono> })
                : t('audit.verifyBroken', {
                    id: <Mono>{verdict.brokenAtId ?? '—'}</Mono>,
                    reason: <Mono>{verdict.reason ?? '—'}</Mono>,
                  })}
            </Badge>
          )}
        </div>
        {verdict !== null && !verdict.ok ? (
          <>
            <Notice kind="danger">{t('audit.verifyMeaning')}</Notice>
            {verdict.hint === 'wrong_key_or_genesis' ? (
              <Notice kind="warn">{t('audit.verifyHint')}</Notice>
            ) : null}
          </>
        ) : null}
      </Card>

      <Card wide>
        <div className="field">
          <label htmlFor="event-filter">{t('audit.filter')}</label>
          {/* A native select, styled only where it can be: the closed control. An `<option>`'s
              popup is drawn by the operating system in every engine, so styling one is honoured
              on one platform and ignored on the next — `docs/UI.md` §*The select* says so. */}
          <div className="select-wrap">
            <select
              id="event-filter"
              value={filter}
              onChange={(change) => {
                setFilter(change.target.value);
                setEntries([]);
                setCursor(null);
                setEnd(false);
              }}
            >
              <option value="">{t('audit.filterAll')}</option>
              {events.map((event) => (
                <option key={event} value={event}>
                  {event}
                </option>
              ))}
            </select>
          </div>
        </div>

        <DataTable
          spec={AUDIT_TABLE}
          rows={rows}
          loading={busy && entries.length === 0}
          empty={t('audit.end')}
        />

        <div className="row">
          {end ? (
            <span className="hint">{t('audit.end')}</span>
          ) : (
            <Button onClick={() => void load(cursor, filter)} busy={busy} disabled={cursor === null}>
              {t('audit.more')}
            </Button>
          )}
        </div>
      </Card>
    </>
  );
}

/**
 * Key and value, one pair per line, each pair a single left-to-right island.
 *
 * The pair is one island rather than two because both halves are Latin technical values and the
 * *order* of the two is part of the value: a key and its value separated across a direction
 * boundary reads as two unrelated tokens.
 */
function Pairs({ pairs }: { pairs: MetaPair[] }): React.JSX.Element {
  return (
    <span className="pairs">
      {pairs.map((pair) => (
        <Mono key={pair.key}>
          <span className="pair-key">{pair.key}</span> {pair.value}
        </Mono>
      ))}
    </span>
  );
}
