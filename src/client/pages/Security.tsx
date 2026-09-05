import { useState } from 'react';
import { Button, Card, CopyButton, Dialog, Field, Notice } from '../components/ui.js';
import { MonoBlock } from '../components/Ltr.js';
import { useLocale } from '../i18n/index.js';
import { api, ApiError } from '../lib/api.js';
import type {
  BasePathRegeneratedResponse,
  MeResponse,
  PasswordChangedResponse,
  RecoveryCodesResponse,
} from '../../shared/types.js';

/**
 * The four privileged actions, all step-up gated, and **three of them can lock the operator out**.
 *
 * So each states its consequence *before* the click and not after. That is the whole design of
 * this screen: the API already refuses without a step-up, and `lib/api.ts` already raises the
 * prompt — what this adds is that nobody presses one of these without having read what it does.
 *
 * The base-path button is the most dangerous control in the panel. The route does return the new
 * prefix (`BasePathRegeneratedResponse.basePath`), which was worth confirming before building a
 * button for it: if it did not, the operator would have no way to learn the new address and the
 * button would be a lockout with extra steps. It also answers `restartRequired: true`, because the
 * prefix and its pre-routing gate are fixed at boot.
 */
export function Security({
  me,
  refresh,
}: {
  me: MeResponse;
  refresh: () => Promise<void>;
}): React.JSX.Element {
  const { t, ts } = useLocale();

  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<React.ReactNode | null>(null);
  const [done, setDone] = useState<React.ReactNode | null>(null);

  const [codes, setCodes] = useState<string[] | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmBasePath, setConfirmBasePath] = useState(false);
  const [typed, setTyped] = useState('');
  const [newBasePath, setNewBasePath] = useState<string | null>(null);

  /** The word the operator has to type. From the dictionary, so it is in their language. */
  const confirmWord = ts('common.confirm');

  const describe = (err: unknown): React.ReactNode => {
    if (err instanceof ApiError) {
      switch (err.code) {
        case 'weak_password':
          return t('error.weakPassword');
        case 'conflict':
          return t('security.basePath.envPinned');
        case 'step_up_required':
          // The operator cancelled the prompt. Not an error to shout about.
          return t('error.stepUpRequired');
        default:
          return t('error.unknown');
      }
    }
    return t('error.network');
  };

  const changePassword = async (): Promise<void> => {
    if (password !== repeat) {
      setError(t('security.password.mismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await api.post<PasswordChangedResponse>('/api/security/password', {
        newPassword: password,
      });
      setPassword('');
      setRepeat('');
      setDone(t('security.password.done', { count: res.revokedSessions }));
      await refresh();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const regenerateCodes = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<RecoveryCodesResponse>('/api/security/recovery-codes');
      setCodes(res.recoveryCodes);
      setAcknowledged(false);
      await refresh();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const disableTwoFactor = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/security/2fa/disable');
      setConfirmDisable(false);
      setDone(t('security.2fa.done'));
      await refresh();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const regenerateBasePath = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<BasePathRegeneratedResponse>(
        '/api/security/base-path/regenerate',
      );
      setNewBasePath(res.basePath);
      setConfirmBasePath(false);
      setTyped('');
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>{t('security.title')}</h1>
      <p className="lede">{t('stepup.explain')}</p>

      {error === null ? null : <Notice kind="danger">{error}</Notice>}
      {done === null ? null : <Notice kind="ok">{done}</Notice>}

      {/* ── Password ───────────────────────────────────────────────────────── */}
      <Card title={t('security.password.title')}>
        <Notice kind="warn">{t('security.password.consequence')}</Notice>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void changePassword();
          }}
        >
          <Field
            id="new-password"
            label={t('security.password.new')}
            value={password}
            onChange={setPassword}
            type="password"
            autoComplete="new-password"
            disabled={busy}
            required
            ltr
          />
          <Field
            id="repeat-password"
            label={t('security.password.repeat')}
            value={repeat}
            onChange={setRepeat}
            type="password"
            autoComplete="new-password"
            disabled={busy}
            required
            ltr
          />
          <Button type="submit" kind="danger" busy={busy} disabled={password === ''}>
            {t('security.password.submit')}
          </Button>
        </form>
      </Card>

      {/* ── Recovery codes ─────────────────────────────────────────────────── */}
      <Card title={t('security.recovery.title')}>
        <Notice kind="warn">{t('security.recovery.consequence')}</Notice>
        <p className="hint">
          {t('recovery.remaining', { count: me.recoveryCodesRemaining })}
        </p>
        <Button kind="danger" onClick={() => void regenerateCodes()} busy={busy}>
          {t('security.recovery.submit')}
        </Button>
      </Card>

      {/* Shown exactly once, and not dismissable by Escape: these ten strings exist nowhere
          else after this dialog closes. */}
      <Dialog
        open={codes !== null}
        onClose={() => setCodes(null)}
        title={t('recovery.title')}
        dismissable={false}
      >
        <Notice kind="warn">{t('recovery.explain')}</Notice>
        <MonoBlock>
          {(codes ?? []).map((one) => (
            <div key={one}>{one}</div>
          ))}
        </MonoBlock>
        <div className="row">
          <CopyButton value={(codes ?? []).join('\n')} />
        </div>
        <p className="hint">{t('secrets.clipboardWarning')}</p>
        <div className="field">
          <label htmlFor="ack-codes">
            <input
              id="ack-codes"
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />{' '}
            {t('recovery.acknowledge')}
          </label>
        </div>
        <Button kind="primary" disabled={!acknowledged} onClick={() => setCodes(null)}>
          {t('common.close')}
        </Button>
      </Dialog>

      {/* ── Two-factor off ─────────────────────────────────────────────────── */}
      <Card title={t('security.2fa.title')}>
        <Notice kind="danger">{t('security.2fa.consequence')}</Notice>
        <Button
          kind="danger"
          onClick={() => setConfirmDisable(true)}
          disabled={busy || !me.totpEnabled}
        >
          {t('security.2fa.submit')}
        </Button>
      </Card>

      <Dialog
        open={confirmDisable}
        onClose={() => setConfirmDisable(false)}
        title={t('security.2fa.title')}
      >
        <Notice kind="danger">{t('security.2fa.consequence')}</Notice>
        <div className="row">
          <Button kind="danger" onClick={() => void disableTwoFactor()} busy={busy}>
            {t('security.2fa.submit')}
          </Button>
          <Button onClick={() => setConfirmDisable(false)}>{t('common.cancel')}</Button>
        </div>
      </Dialog>

      {/* ── The base path ──────────────────────────────────────────────────── */}
      <Card title={t('security.basePath.title')}>
        <Notice kind="danger">{t('security.basePath.consequence')}</Notice>
        <Button kind="danger" onClick={() => setConfirmBasePath(true)} disabled={busy}>
          {t('security.basePath.submit')}
        </Button>
      </Card>

      <Dialog
        open={confirmBasePath}
        onClose={() => {
          setConfirmBasePath(false);
          setTyped('');
        }}
        title={t('security.basePath.title')}
      >
        <Notice kind="danger">{t('security.basePath.consequence')}</Notice>
        {/* A typed confirmation rather than a second button. This is the one action whose cost
            is losing access to the panel entirely, and a button is one stray click. */}
        <Field
          id="confirm-word"
          label={t('security.basePath.typeToConfirm', { word: confirmWord })}
          value={typed}
          onChange={setTyped}
          disabled={busy}
        />
        <div className="row">
          <Button
            kind="danger"
            onClick={() => void regenerateBasePath()}
            busy={busy}
            disabled={typed.trim() !== confirmWord}
          >
            {t('security.basePath.submit')}
          </Button>
          <Button
            onClick={() => {
              setConfirmBasePath(false);
              setTyped('');
            }}
          >
            {t('common.cancel')}
          </Button>
        </div>
      </Dialog>

      {/* The new prefix, prominently, and not dismissable by Escape: the panel cannot show it
          again from a page it no longer serves. */}
      <Dialog
        open={newBasePath !== null}
        onClose={() => setNewBasePath(null)}
        title={t('security.basePath.newValue')}
        dismissable={false}
      >
        <MonoBlock>/{newBasePath}</MonoBlock>
        <div className="row">
          <CopyButton value={`/${newBasePath ?? ''}`} />
        </div>
        <Notice kind="danger">{t('security.basePath.saveIt')}</Notice>
        <Notice kind="warn">{t('security.basePath.restart')}</Notice>
        <p className="hint">{t('secrets.clipboardWarning')}</p>
        <Button onClick={() => setNewBasePath(null)}>{t('common.close')}</Button>
      </Dialog>
    </>
  );
}
