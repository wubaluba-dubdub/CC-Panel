import { useEffect, useRef, useState } from 'react';
import { Button, Card, CopyButton, Field, Notice, Status } from '../components/ui.js';
import { MonoBlock } from '../components/Ltr.js';
import { useLocale, LOCALES } from '../i18n/index.js';
import { api, ApiError, NetworkError } from '../lib/api.js';
import { formatDuration } from '../lib/format.js';
import type {
  EnrollmentResponse,
  EnrollmentVerifiedResponse,
  LoginResponse,
  MeResponse,
  TotpStepResponse,
} from '../../shared/types.js';

/**
 * Signing in, against the server's real behaviour rather than the conventional one.
 *
 * Four things here are consequences of M1.4 and M1.5, and all four are invisible until a human
 * tries it:
 *
 * 1. **A login attempt can legitimately take thirty seconds.** The progressive delay pads a
 *    failed attempt to a target measured from the start, and the target grows with the failure
 *    count — that is what replaces locking the account. So there is no client timeout under
 *    ~35 s, the submit button is disabled while it runs, and the wait is announced through
 *    `aria-live` rather than being a dead screen.
 * 2. **A second concurrent attempt is a 429 that is not a rate limit.** The single-flight gate
 *    admits one attempt plus one queued and rejects the third *before reading any credential*.
 *    `auth_in_progress` says "an attempt is already running"; `rate_limited` says "wait
 *    `Retry-After` seconds". Telling the operator to wait when the real answer is "your other
 *    tab is mid-login" sends them to the wrong fix.
 * 3. **The pre-session cookie carries `Max-Age=299`.** So the second-factor step has a
 *    five-minute window, it is shown counting down, and when it closes the screen says so and
 *    returns to the password step — rather than 401-looping against a cookie the browser has
 *    already discarded.
 * 4. **A recovery code goes in the same field as a TOTP code.** The server accepts either at
 *    `/api/auth/login/totp`, which is not guessable, so the screen says it.
 */

type Stage = 'password' | 'totp' | 'setup' | 'recovery-codes';

/** How long the client waits before giving up on a login. */
const LOGIN_TIMEOUT_MS = 40_000;

/** The pre-auth session's lifetime, mirrored from `PRE_AUTH_LIFETIME_MS`. */
const PRE_SESSION_MS = 5 * 60_000;

export function Login({ onAuthenticated }: { onAuthenticated: () => void }): React.JSX.Element {
  const { t, locale, setLocale } = useLocale();
  const [stage, setStage] = useState<Stage>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<React.ReactNode | null>(null);
  const [pending, setPending] = useState<React.ReactNode | null>(null);
  const [enrolment, setEnrolment] = useState<EnrollmentResponse | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState<number>(PRE_SESSION_MS);

  // ── The five-minute window on the second-factor step ─────────────────────
  //
  // Shown counting down, because a five-minute window the operator cannot see is a window they
  // will walk away from. When it closes the screen returns to the password step with a reason;
  // the alternative is a 401 on submit, which looks like a wrong code.
  useEffect(() => {
    if (expiresAt === null) return;
    const tick = (): void => {
      const left = expiresAt - Date.now();
      setRemaining(left);
      if (left <= 0) {
        setExpiresAt(null);
        setStage('password');
        setCode('');
        setPassword('');
        setError(t('totp.expired'));
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, t]);

  const describe = (err: unknown, fallbackKey: 'login.failed' | 'totp.failed'): React.ReactNode => {
    if (err instanceof NetworkError) return t('error.network');
    if (!(err instanceof ApiError)) return t('error.unknown');
    switch (err.code) {
      case 'auth_in_progress':
        return t('login.inProgress');
      case 'rate_limited':
        return t('login.rateLimited', { seconds: err.retryAfterSeconds ?? 60 });
      case 'bad_credentials':
        return t(fallbackKey);
      case 'conflict':
        // "no enrolment in progress" or "enrolment is not complete": the pre-session moved on
        // under a stale tab. Starting again is the only useful advice.
        return t('totp.expired');
      case 'too_large':
        return t('error.tooLarge');
      case 'bad_request':
        return t('error.badRequest');
      default:
        return t(fallbackKey);
    }
  };

  const submitPassword = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    // Announced immediately, because the wait is the point: up to thirty seconds of silence with
    // a disabled button and no explanation is indistinguishable from a broken panel.
    setPending(t('login.slowWarning'));
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
    try {
      const res = await api.post<LoginResponse>(
        '/api/auth/login',
        { username, password },
        { signal: controller.signal },
      );
      setExpiresAt(Date.now() + PRE_SESSION_MS);
      setStage(res.stage === 'setup' ? 'setup' : 'totp');
      setPassword('');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') setError(t('error.network'));
      else setError(describe(err, 'login.failed'));
    } finally {
      window.clearTimeout(timeout);
      setPending(null);
      setBusy(false);
    }
  };

  const submitCode = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setPending(t('login.working'));
    try {
      const res = await api.post<TotpStepResponse>('/api/auth/login/totp', { code });
      setCode('');
      setExpiresAt(null);
      if (res.usedRecoveryCode === true) {
        // Worth saying out loud: a spent recovery code is one fewer way back in, and the count
        // is the only warning before there are none.
        setPending(t('totp.usedRecoveryCode', { count: res.recoveryCodesRemaining }));
      }
      onAuthenticated();
    } catch (err) {
      setError(describe(err, 'totp.failed'));
    } finally {
      setBusy(false);
    }
  };

  const beginEnrolment = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setEnrolment(await api.post<EnrollmentResponse>('/api/auth/totp/enroll'));
    } catch (err) {
      setError(describe(err, 'login.failed'));
    } finally {
      setBusy(false);
    }
  };

  const verifyEnrolment = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<EnrollmentVerifiedResponse>('/api/auth/totp/enroll/verify', {
        code,
      });
      setCode('');
      setRecoveryCodes(res.recoveryCodes);
      setEnrolment(null);
      setExpiresAt(null);
      setStage('recovery-codes');
    } catch (err) {
      setError(describe(err, 'totp.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        {/* The language switch has to work *before* sign-in: the login screen is the first thing
            an operator sees, and `PATCH /api/settings/locale` needs a full session. So this
            stores the choice in `localStorage`, where `bootstrap.js` reads it before first paint
            on the next load — an unauthenticated visitor can change what their browser shows and
            cannot change what the panel stores. */}
        <div className="row" role="radiogroup" aria-label={useLocale().ts('common.language')}>
          {LOCALES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={locale === candidate}
              className={locale === candidate ? 'chip chip-on' : 'chip'}
              onClick={() => setLocale(candidate)}
            >
              {candidate === 'en' ? t('common.english') : t('common.persian')}
            </button>
          ))}
        </div>

        {stage === 'password' ? (
          <Card title={t('login.title')}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitPassword();
              }}
            >
              <Field
                id="username"
                label={t('login.username')}
                value={username}
                onChange={setUsername}
                autoComplete="username"
                disabled={busy}
                required
                autoFocus
                ltr
              />
              <Field
                id="password"
                label={t('login.password')}
                value={password}
                onChange={setPassword}
                type="password"
                autoComplete="current-password"
                disabled={busy}
                required
                ltr
              />
              {error === null ? null : <Notice kind="danger">{error}</Notice>}
              {/* `role="status"` rather than `alert`: the slow path is expected behaviour, not a
                  failure, and an assertive announcement would interrupt whatever the operator's
                  screen reader was saying. */}
              {pending === null ? null : (
                <Notice kind="info" live>
                  {pending}
                </Notice>
              )}
              <Button type="submit" kind="primary" busy={busy}>
                {busy ? t('login.working') : t('login.submit')}
              </Button>
            </form>
          </Card>
        ) : null}

        {stage === 'totp' ? (
          <Card title={t('totp.title')}>
            <p>{t('totp.explain')}</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitCode();
              }}
            >
              <Field
                id="code"
                label={t('totp.code')}
                value={code}
                onChange={setCode}
                inputMode="numeric"
                autoComplete="one-time-code"
                disabled={busy}
                required
                autoFocus
                ltr
                maxLength={64}
              />
              {error === null ? null : <Notice kind="danger">{error}</Notice>}
              <Status>{t('totp.expiresIn', { time: formatDuration(remaining, locale) })}</Status>
              <Button type="submit" kind="primary" busy={busy}>
                {busy ? t('login.working') : t('totp.submit')}
              </Button>
            </form>
          </Card>
        ) : null}

        {stage === 'setup' ? (
          <Card title={t('enroll.title')}>
            <p>{t('enroll.explain')}</p>
            {enrolment === null ? (
              <>
                {error === null ? null : <Notice kind="danger">{error}</Notice>}
                <Button kind="primary" onClick={() => void beginEnrolment()} busy={busy}>
                  {t('enroll.title')}
                </Button>
              </>
            ) : (
              <>
                {/* The secret and the URI, both in left-to-right islands with a copy action.
                    No QR code: the image would have to be rendered from the secret, and a
                    camera does nothing typing cannot — `enroll.noQr` says so on screen. */}
                <p>{t('enroll.secret')}</p>
                <MonoBlock>{enrolment.secret}</MonoBlock>
                <div className="row">
                  <CopyButton value={enrolment.secret} />
                </div>
                <p>{t('enroll.uri')}</p>
                <MonoBlock>{enrolment.otpauthUri}</MonoBlock>
                <div className="row">
                  <CopyButton value={enrolment.otpauthUri} />
                </div>
                <p className="hint">{t('enroll.noQr')}</p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void verifyEnrolment();
                  }}
                >
                  <Field
                    id="enroll-code"
                    label={t('totp.code')}
                    value={code}
                    onChange={setCode}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    disabled={busy}
                    required
                    ltr
                    maxLength={64}
                  />
                  {error === null ? null : <Notice kind="danger">{error}</Notice>}
                  <Button type="submit" kind="primary" busy={busy}>
                    {t('enroll.verify')}
                  </Button>
                </form>
              </>
            )}
          </Card>
        ) : null}

        {stage === 'recovery-codes' ? (
          <Card title={t('recovery.title')}>
            <Notice kind="warn">{t('recovery.explain')}</Notice>
            <MonoBlock>
              {recoveryCodes.map((one) => (
                <div key={one}>{one}</div>
              ))}
            </MonoBlock>
            <div className="row">
              <CopyButton value={recoveryCodes.join('\n')} />
            </div>
            <p className="hint">{t('secrets.clipboardWarning')}</p>
            <div className="field">
              <label htmlFor="ack">
                <input
                  id="ack"
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />{' '}
                {t('recovery.acknowledge')}
              </label>
            </div>
            {/* The continue button is gated on the acknowledgement, because this is the only
                time these ten strings exist anywhere but the operator's notes. */}
            <Button kind="primary" disabled={!acknowledged} onClick={onAuthenticated}>
              {t('recovery.done')}
            </Button>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The step-up prompt: a password **and** a fresh code, valid five minutes on this session.
 *
 * Driven by `lib/api.ts` rather than by a screen: any request can come back
 * `403 step_up_required`, and the wrapper opens this, waits, and retries the original request
 * exactly once. A screen that handled its own step-up would handle it four different ways.
 */
export function StepUpForm({
  onGranted,
  onCancel,
}: {
  onGranted: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { t } = useLocale();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<React.ReactNode | null>(null);
  const first = useRef<HTMLFormElement>(null);

  useEffect(() => {
    first.current?.querySelector('input')?.focus();
  }, []);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/step-up', { password, code }, { noStepUp: true });
      setPassword('');
      setCode('');
      onGranted();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'auth_in_progress') {
        setError(t('login.inProgress'));
      } else if (err instanceof ApiError && err.code === 'rate_limited') {
        setError(t('login.rateLimited', { seconds: err.retryAfterSeconds ?? 60 }));
      } else if (err instanceof NetworkError) {
        setError(t('error.network'));
      } else {
        setError(t('stepup.failed'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      ref={first}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p>{t('stepup.explain')}</p>
      <Field
        id="stepup-password"
        label={t('login.password')}
        value={password}
        onChange={setPassword}
        type="password"
        autoComplete="current-password"
        disabled={busy}
        required
        ltr
      />
      <Field
        id="stepup-code"
        label={t('totp.code')}
        value={code}
        onChange={setCode}
        inputMode="numeric"
        autoComplete="one-time-code"
        disabled={busy}
        required
        ltr
        maxLength={64}
      />
      {error === null ? null : <Notice kind="danger">{error}</Notice>}
      <div className="row">
        <Button type="submit" kind="primary" busy={busy}>
          {t('stepup.submit')}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </Button>
      </div>
      {/* The delay applies here too: step-up goes through `runAuthAttempt`, so a wrong password
          costs the same growing wait a wrong login does. */}
      <p className="hint">{t('login.slowWarning')}</p>
    </form>
  );
}

/** The stored locale, cached for the next boot once `me` is known. */
export function useCachedLocale(me: MeResponse | null): void {
  const { setLocale } = useLocale();
  useEffect(() => {
    if (me === null || me.locale === null) return;
    try {
      window.localStorage.setItem('panel.locale', me.locale);
    } catch {
      /* storage unavailable */
    }
    setLocale(me.locale);
  }, [me, setLocale]);
}
