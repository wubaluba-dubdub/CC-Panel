import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, Notice } from './components/ui.js';
import { useLocale } from './i18n/index.js';
import { setApiHandlers } from './lib/api.js';
import { useSession } from './lib/session.js';
import { Login, StepUpForm, useCachedLocale } from './pages/Login.js';
import { Shell } from './Shell.js';

/**
 * The top of the tree: who is signed in, and the two dialogs any screen can raise.
 *
 * ── Why the step-up prompt lives here ───────────────────────────────────────
 *
 * Any request can come back `403 step_up_required`, and `lib/api.ts` is what notices — it opens
 * this prompt, waits for it, and retries the original request exactly once. So the dialog has to
 * be mounted above every screen and outside every one of them, and the promise the wrapper waits
 * on is resolved from here. A screen that handled its own step-up would handle it four different
 * ways and would still miss the fifth call site.
 */
export function App(): React.JSX.Element {
  const { t } = useLocale();
  const { state, refresh, forget } = useSession();
  const [stepUpOpen, setStepUpOpen] = useState(false);
  /** Resolves the promise `lib/api.ts` is waiting on. Null when no request is waiting. */
  const pendingStepUp = useRef<((granted: boolean) => void) | null>(null);

  const onStepUpRequired = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        pendingStepUp.current = resolve;
        setStepUpOpen(true);
      }),
    [],
  );

  const closeStepUp = useCallback((granted: boolean) => {
    setStepUpOpen(false);
    const resolve = pendingStepUp.current;
    pendingStepUp.current = null;
    // Always resolved, never left hanging: a cancelled dialog that resolved nothing would leave
    // the original request's promise pending forever and the screen spinning.
    resolve?.(granted);
  }, []);

  useEffect(() => {
    setApiHandlers({
      onUnauthenticated: () => {
        // The session is gone — expired, revoked from another device, or rotated out from under a
        // stale tab. Drop to the sign-in screen rather than leaving a screen full of stale data
        // that 401s on every action.
        forget();
        closeStepUp(false);
      },
      onStepUpRequired,
    });
  }, [forget, onStepUpRequired, closeStepUp]);

  const me = state.status === 'known' ? state.me : null;
  useCachedLocale(me);

  if (state.status === 'loading') {
    return (
      <main className="boot">
        <p>{t('common.loading')}</p>
      </main>
    );
  }

  if (state.status === 'unreachable') {
    // Not "signed out": telling the operator to sign in when the server cannot be reached sends
    // them to type a password into a page that cannot check it.
    return (
      <main className="boot">
        <Notice kind="danger">{t('error.network')}</Notice>
      </main>
    );
  }

  const authenticated = me !== null && me.stage === 'authenticated';

  return (
    <>
      {authenticated ? (
        <Shell me={me} onSignedOut={forget} refresh={refresh} />
      ) : (
        <Login onAuthenticated={() => void refresh()} />
      )}

      <Dialog open={stepUpOpen} onClose={() => closeStepUp(false)} title={t('stepup.title')}>
        <StepUpForm
          onGranted={() => {
            closeStepUp(true);
            void refresh();
          }}
          onCancel={() => closeStepUp(false)}
        />
      </Dialog>
    </>
  );
}
