import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, CopyButton, Field, Notice, ScrollRegion } from '../components/ui.js';
import { Mono, MonoBlock } from '../components/Ltr.js';
import { useLocale } from '../i18n/index.js';
import { api, ApiError } from '../lib/api.js';
import { formatDuration, formatTechnicalDate } from '../lib/format.js';
import type {
  NotificationQueuedResponse,
  NotificationStatusResponse,
  SecretMetadataResponse,
  SecretRevealResponse,
} from '../../shared/types.js';

/**
 * Stored credentials, and the Telegram channel's health.
 *
 * ── What is shown, and what is deliberately not ─────────────────────────────
 *
 * Names with set/unset, and **never a masked value**. `mask()` keeps the last four characters,
 * which is harmless for a 46-character bot token and is not harmless for a nine-digit chat id —
 * four digits of a stable identifier, in a response that can be read again and again. The panel
 * reports a length instead, which is what `npm run preflight` does and for the same reason: it
 * catches a truncated paste and a variable that never arrived, and reveals nothing else.
 *
 * ── Revealing ───────────────────────────────────────────────────────────────
 *
 * Step-up gated (the wrapper raises the prompt), one at a time, hidden again after twenty
 * seconds, and **out of the DOM when hidden** rather than merely invisible — a value in a
 * collapsed element is a value in the page, readable by anything that can walk it and present in
 * any screenshot of the tab. Every reveal writes an audit row, which the screen says before the
 * click rather than after.
 */

/** How long a revealed value stays on screen. Short enough to read once, not to walk away from. */
const REVEAL_MS = 20_000;

export function Secrets(): React.JSX.Element {
  const { t, ts, locale } = useLocale();
  const [secrets, setSecrets] = useState<SecretMetadataResponse['secrets'] | null>(null);
  const [telegram, setTelegram] = useState<NotificationStatusResponse | null>(null);
  const [error, setError] = useState<React.ReactNode | null>(null);
  const [notice, setNotice] = useState<React.ReactNode | null>(null);
  const [busy, setBusy] = useState(false);

  const [revealed, setRevealed] = useState<SecretRevealResponse | null>(null);
  const [revealLeft, setRevealLeft] = useState(REVEAL_MS);

  const [scope, setScope] = useState('global');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  const load = useCallback(async () => {
    try {
      const [list, status] = await Promise.all([
        api.get<SecretMetadataResponse>('/api/secrets'),
        api.get<NotificationStatusResponse>('/api/notifications/telegram'),
      ]);
      setSecrets(list.secrets);
      setTelegram(status);
      setError(null);
    } catch {
      setError(t('error.network'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // The countdown, and the removal. `setRevealed(null)` unmounts the block, so the value leaves
  // the DOM rather than being hidden in it.
  useEffect(() => {
    if (revealed === null) return;
    setRevealLeft(REVEAL_MS);
    const started = Date.now();
    const timer = window.setInterval(() => {
      const left = REVEAL_MS - (Date.now() - started);
      setRevealLeft(left);
      if (left <= 0) setRevealed(null);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [revealed]);

  const reveal = async (secretScope: string, secretName: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<SecretRevealResponse>('/api/secrets/reveal', {
        scope: secretScope,
        name: secretName,
      });
      setRevealed(res);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'not_found' ? t('error.notFound') : t('error.unknown'));
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.put('/api/secrets', { scope, name, value });
      setValue('');
      setNotice(t('secrets.saved'));
      await load();
    } catch {
      setError(t('error.unknown'));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.post<NotificationQueuedResponse>('/api/notifications/test');
      setNotice(t('telegram.testQueued', { id: <Mono>{res.queued}</Mono> }));
      await load();
    } catch {
      setError(t('error.unknown'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>{t('secrets.title')}</h1>
      <p className="lede">{t('secrets.explain')}</p>

      {error === null ? null : <Notice kind="danger">{error}</Notice>}
      {notice === null ? null : <Notice kind="ok">{notice}</Notice>}

      <Card wide>
        {secrets === null ? (
          <p className="hint">{t('common.loading')}</p>
        ) : secrets.length === 0 ? (
          <p>{t('secrets.empty')}</p>
        ) : (
          <ScrollRegion label={ts('secrets.title')}>
            <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('secrets.scope')}</th>
                <th scope="col">{t('secrets.name')}</th>
                <th scope="col">{t('secrets.updated')}</th>
                <th scope="col">
                  <span className="hint">{t('secrets.reveal')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {secrets.map((secret) => (
                <tr key={`${secret.scope}/${secret.name}`}>
                  <td>
                    <Mono>{secret.scope}</Mono>
                  </td>
                  <td>
                    <Mono>{secret.name}</Mono>
                  </td>
                  <td>
                    <Mono>{formatTechnicalDate(secret.updatedAt, locale)}</Mono>
                  </td>
                  <td>
                    <Button
                      onClick={() => void reveal(secret.scope, secret.name)}
                      disabled={busy || revealed !== null}
                    >
                      {t('secrets.reveal')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
            </table>
          </ScrollRegion>
        )}
        <p className="hint">{t('secrets.revealWarning')}</p>
      </Card>

      {/* One at a time, out of the DOM when hidden, and counting down so the operator knows it
          will go. */}
      {revealed === null ? null : (
        <Card title={<Mono>{`${revealed.scope}/${revealed.name}`}</Mono>}>
          <MonoBlock>{revealed.value}</MonoBlock>
          <div className="row">
            <CopyButton value={revealed.value} />
            <Button onClick={() => setRevealed(null)}>{t('secrets.hide')}</Button>
          </div>
          <p className="hint">
            {t('secrets.revealed', { seconds: Math.max(0, Math.ceil(revealLeft / 1000)) })}
          </p>
          <p className="hint">{t('secrets.clipboardWarning')}</p>
        </Card>
      )}

      <Card title={t('secrets.set')}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field id="secret-scope" label={t('secrets.scope')} value={scope} onChange={setScope} ltr disabled={busy} />
          <Field id="secret-name" label={t('secrets.name')} value={name} onChange={setName} ltr disabled={busy} />
          <Field
            id="secret-value"
            label={t('secrets.value')}
            value={value}
            onChange={setValue}
            type="password"
            autoComplete="off"
            ltr
            disabled={busy}
          />
          <Button type="submit" kind="primary" busy={busy} disabled={name === '' || value === ''}>
            {t('secrets.save')}
          </Button>
        </form>
      </Card>

      <TelegramCard status={telegram} onTest={() => void sendTest()} busy={busy} />
    </>
  );
}

/**
 * The Telegram channel, reported and testable. **M2.5 owns configuring it.**
 *
 * The health indicator is based on the **age of the last successful send**, not on queue depth,
 * because three states have to look different and only that separates the third from healthy: a
 * channel that has never worked, a channel that stopped working, and a queue that is empty
 * because nothing was enqueued. An empty queue is not evidence of anything.
 */
function TelegramCard({
  status,
  onTest,
  busy,
}: {
  status: NotificationStatusResponse | null;
  onTest: () => void;
  busy: boolean;
}): React.JSX.Element {
  const { t, locale } = useLocale();
  if (status === null) return <Card title={t('telegram.title')} />;

  /** Twelve hours with nothing delivered, on a panel that logs in and alerts, is a dead channel. */
  const STALE_MS = 12 * 60 * 60_000;
  const lastSuccessMs = status.lastSuccessAt === null ? null : Date.parse(status.lastSuccessAt);
  const age = lastSuccessMs === null ? null : Date.now() - lastSuccessMs;

  const health =
    !status.configured
      ? { kind: 'warn' as const, text: t('telegram.notConfigured') }
      : lastSuccessMs === null
        ? { kind: 'danger' as const, text: t('telegram.neverDelivered') }
        : age !== null && age > STALE_MS
          ? { kind: 'warn' as const, text: t('telegram.stale', { age: formatDuration(age, locale) }) }
          : { kind: 'ok' as const, text: t('telegram.healthy') };

  return (
    <Card title={t('telegram.title')}>
      <p className="row">
        <Badge kind={health.kind}>{t('telegram.title')}</Badge> {health.text}
      </p>
      <table className="table">
        <tbody>
          <tr>
            <th scope="row">{t('telegram.botToken')}</th>
            <td>
              {status.botToken.set
                ? t('common.characters', { count: <Mono>{status.botToken.length ?? 0}</Mono> })
                : t('common.notSet')}
            </td>
          </tr>
          <tr>
            <th scope="row">{t('telegram.chatId')}</th>
            <td>
              {status.chatId.set
                ? t('common.characters', { count: <Mono>{status.chatId.length ?? 0}</Mono> })
                : t('common.notSet')}
            </td>
          </tr>
          <tr>
            <th scope="row">{t('telegram.queue')}</th>
            <td>
              {t('telegram.queueCounts', {
                pending: <Mono>{status.queue.pending}</Mono>,
                sending: <Mono>{status.queue.sending}</Mono>,
                sent: <Mono>{status.queue.sent}</Mono>,
                abandoned: <Mono>{status.queue.abandoned}</Mono>,
              })}
            </td>
          </tr>
          <tr>
            <th scope="row">{t('telegram.lastSuccess')}</th>
            <td>
              <Mono>{formatTechnicalDate(status.lastSuccessAt, locale) ?? t('common.never')}</Mono>
            </td>
          </tr>
          {status.lastFailure === null ? null : (
            <tr>
              <th scope="row">{t('telegram.lastFailure')}</th>
              <td>
                {/* A category and a time, never Telegram's own text — which echoes what was
                    sent. The category is a code from the transport's closed set. */}
                <Mono>{status.lastFailure.category}</Mono>{' '}
                <Mono>{formatTechnicalDate(status.lastFailure.at, locale)}</Mono>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {status.dropped.count === 0 ? null : (
        <Notice kind="warn">{t('telegram.dropped', { count: status.dropped.count })}</Notice>
      )}
      <div className="row">
        {/* Full session, no step-up: a test send discloses nothing, and demanding a fresh code to
            check whether notifications work pushes the operator toward not checking. */}
        <Button onClick={onTest} disabled={busy || !status.configured}>
          {t('telegram.test')}
        </Button>
      </div>
      <p className="hint">{t('telegram.moreInM25')}</p>
    </Card>
  );
}
