import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Notice } from '../components/ui.js';
import { Mono } from '../components/Ltr.js';
import { useLocale } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { formatTechnicalDate } from '../lib/format.js';
import type { AuditEntryView, AuditPageResponse, AuditVerifyResponse } from '../../shared/types.js';

/**
 * The audit log, and the one question it exists to answer.
 *
 * ── Metadata is text, and never anything that interprets markup ─────────────
 *
 * A row's `meta` carries values recorded from attacker-influenced input — a user-agent string, a
 * secret's name, a path. It is rendered as a string in a left-to-right block and nothing else;
 * `dangerouslySetInnerHTML` is an eslint error in this project and a static-scan failure, which
 * is what keeps that true when a later screen wants "nicer" formatting.
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
  const { t, locale } = useLocale();
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

      <Card>
        <div className="field">
          <label htmlFor="event-filter">{t('audit.filter')}</label>
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

        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('audit.when')}</th>
              <th scope="col">{t('audit.event')}</th>
              <th scope="col">{t('audit.outcome')}</th>
              <th scope="col">{t('audit.meta')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>
                  <Mono>{formatTechnicalDate(entry.ts, locale)}</Mono>
                </td>
                <td>
                  {/* The event name is a code from `AuditEvent`, shown as-is: translating a
                      hundred event names would be a hundred strings that have to stay in step
                      with the server's enum, and the operator greps for these. */}
                  <Mono>{entry.event}</Mono>
                </td>
                <td>
                  <Badge kind={entry.outcome === 'success' ? 'ok' : 'danger'}>{entry.outcome}</Badge>
                </td>
                <td>
                  {/* Attacker-influenced content, rendered as text. Never markup. */}
                  <Mono>{JSON.stringify(entry.meta)}</Mono>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

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
