import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Notice } from '../components/ui.js';
import { DataTable, type DataRow } from '../components/Table.js';
import { Mono, MonoBlock } from '../components/Ltr.js';
import { useLocale } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { formatTechnicalDate } from '../lib/format.js';
import { SESSIONS_TABLE, type SessionColumnKey } from '../lib/table.js';
import { browserLabel, summariseClient } from '../lib/user-agent.js';
import type { RevokedResponse, SessionListResponse, SessionSummary } from '../../shared/types.js';

/**
 * Every session that can reach this panel, and the two ways to end one.
 *
 * **There is no address column, and there must not be one.** The panel deliberately decides
 * nothing from a client address — `utils/client-ip.ts` is the only file that reads one, and a
 * static scan keeps it that way — so an address here would be a value the operator could act on
 * that the panel itself refuses to act on. A column of blanks would be worse: it invites somebody
 * to "fix" it later, which is how per-IP logic comes back.
 *
 * ── The client column is a summary, and the raw string is one click away ─────
 *
 * `User-Agent` is a request header, so it is attacker-influenced and unbounded: rendering it raw
 * made it the tallest object on the screen, six monospaced lines of which *Chrome 152 on Windows*
 * was the useful part. `lib/user-agent.ts` reduces it to three facts from a closed set — so no
 * substring of the header reaches the page through that path at all — and the exact bytes are in
 * the row's detail, where the question "is that session mine?" can be answered.
 *
 * ── The current session's action is a sign-out, not a revoke ─────────────────
 *
 * The action column used to be empty for the row the operator is looking at, which reads as a
 * broken feature rather than a deliberate refusal. Revoking your own session and signing out are
 * the same intention, and the sign-out endpoint is the one that also clears the cookie and writes
 * the audit row for it — so the cell offers exactly that, wired to the call the shell's own
 * button makes.
 */
export function Sessions({ onSignOut }: { onSignOut: () => void }): React.JSX.Element {
  const { t, locale } = useLocale();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<React.ReactNode | null>(null);
  const [notice, setNotice] = useState<React.ReactNode | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<SessionListResponse>('/api/sessions');
      setSessions(res.sessions);
      setError(null);
    } catch {
      setError(t('error.network'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: number): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await api.del(`/api/sessions/${id}`);
      await load();
    } catch {
      setError(t('error.unknown'));
    } finally {
      setBusy(false);
    }
  };

  const revokeOthers = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<RevokedResponse>('/api/sessions/revoke-others');
      setNotice(t('sessions.revoked', { count: res.revoked }));
      await load();
    } catch {
      setError(t('error.unknown'));
    } finally {
      setBusy(false);
    }
  };

  const rows: DataRow<SessionColumnKey>[] = (sessions ?? []).map((session) => {
    const client = summariseClient(session.userAgent);
    const browser = browserLabel(client);
    return {
      id: session.id,
      cells: {
        'sessions.level': (
          <>
            {session.authLevel === 'full' ? t('sessions.levelFull') : t('sessions.levelPre')}{' '}
            {session.current ? <Badge kind="ok">{t('sessions.current')}</Badge> : null}
          </>
        ),
        'sessions.created': (
          <Mono className="nowrap">{formatTechnicalDate(session.createdAt, locale)}</Mono>
        ),
        'sessions.lastSeen': (
          <Mono className="nowrap">{formatTechnicalDate(session.lastSeenAt, locale)}</Mono>
        ),
        'sessions.expires': (
          <>
            <Mono className="nowrap">{formatTechnicalDate(session.expiresAt, locale)}</Mono>
            {session.absoluteExpiresAt === null ? null : (
              <>
                <span className="sub">{t('sessions.absolute')}</span>
                <Mono className="nowrap">
                  {formatTechnicalDate(session.absoluteExpiresAt, locale)}
                </Mono>
              </>
            )}
          </>
        ),
        // Three facts from a closed set, in a sentence whose only translated part is the
        // connecting word. A browser is called Chrome in Persian too.
        'sessions.userAgent': t('sessions.clientSummary', {
          browser: browser ?? t('common.unknown'),
          platform: client.platform === 'Unknown' ? t('common.unknown') : client.platform,
        }),
        'sessions.revoke': session.current ? (
          <Button cell onClick={onSignOut} disabled={busy}>
            {t('app.signOut')}
          </Button>
        ) : (
          <Button cell kind="danger" onClick={() => void revoke(session.id)} disabled={busy}>
            {t('sessions.revoke')}
          </Button>
        ),
      },
      detail: (
        <>
          <p className="hint">{t('sessions.clientRaw')}</p>
          <MonoBlock>{session.userAgent ?? t('common.unknown')}</MonoBlock>
        </>
      ),
    };
  });

  return (
    <>
      <h1>{t('sessions.title')}</h1>
      <p className="lede">{t('sessions.explain')}</p>

      {error === null ? null : <Notice kind="danger">{error}</Notice>}
      {notice === null ? null : <Notice kind="ok">{notice}</Notice>}

      <Card wide>
        <DataTable
          spec={SESSIONS_TABLE}
          rows={rows}
          loading={sessions === null}
          empty={t('common.none')}
        />
        <p className="hint">{t('sessions.noIpNote')}</p>
      </Card>

      <Card>
        <div className="row">
          <Button kind="danger" onClick={() => void revokeOthers()} disabled={busy}>
            {t('sessions.revokeOthers')}
          </Button>
          <Button onClick={() => void load()} disabled={busy}>
            {t('common.refresh')}
          </Button>
        </div>
      </Card>
    </>
  );
}
