import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Notice, ScrollRegion } from '../components/ui.js';
import { Mono } from '../components/Ltr.js';
import { useLocale } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { formatTechnicalDate } from '../lib/format.js';
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
 * The client string *is* shown, in a left-to-right island. It is attacker-supplied and rendered as
 * text, never as markup.
 */
export function Sessions(): React.JSX.Element {
  const { t, ts, locale } = useLocale();
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

  return (
    <>
      <h1>{t('sessions.title')}</h1>
      <p className="lede">{t('sessions.explain')}</p>

      {error === null ? null : <Notice kind="danger">{error}</Notice>}
      {notice === null ? null : <Notice kind="ok">{notice}</Notice>}

      <Card wide>
        <ScrollRegion label={ts('sessions.title')}>
          <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('sessions.level')}</th>
              <th scope="col">{t('sessions.created')}</th>
              <th scope="col">{t('sessions.lastSeen')}</th>
              <th scope="col">{t('sessions.expires')}</th>
              <th scope="col">{t('sessions.userAgent')}</th>
              <th scope="col">
                <span className="hint">{t('sessions.revoke')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(sessions ?? []).map((session) => (
              <tr key={session.id}>
                <td>
                  {session.authLevel === 'full' ? t('sessions.levelFull') : t('sessions.levelPre')}{' '}
                  {session.current ? <Badge kind="ok">{t('sessions.current')}</Badge> : null}
                </td>
                <td>
                  <Mono>{formatTechnicalDate(session.createdAt, locale)}</Mono>
                </td>
                <td>
                  <Mono>{formatTechnicalDate(session.lastSeenAt, locale)}</Mono>
                </td>
                <td>
                  <Mono>{formatTechnicalDate(session.expiresAt, locale)}</Mono>
                  {session.absoluteExpiresAt === null ? null : (
                    <>
                      <br />
                      <span className="hint">
                        {t('sessions.absolute')}:{' '}
                        <Mono>{formatTechnicalDate(session.absoluteExpiresAt, locale)}</Mono>
                      </span>
                    </>
                  )}
                </td>
                <td>
                  {/* Attacker-supplied, rendered as text. An LTR island because a user-agent
                      string is Latin in both languages and reorders otherwise. */}
                  <Mono>{session.userAgent ?? '—'}</Mono>
                </td>
                <td>
                  {session.current ? null : (
                    <Button kind="danger" onClick={() => void revoke(session.id)} disabled={busy}>
                      {t('sessions.revoke')}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          </table>
        </ScrollRegion>
        {sessions === null ? <p className="hint">{t('common.loading')}</p> : null}
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
