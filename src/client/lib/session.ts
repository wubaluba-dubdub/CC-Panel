import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api.js';
import type { MeResponse } from '../../shared/types.js';

/**
 * Who is signed in, and how the client finds out.
 *
 * One `GET /api/auth/me` at boot, and again after anything that changes the answer. There is no
 * client-side session state beyond this: the session lives in an `HttpOnly` cookie the script
 * cannot read, which is the whole point of the design — so "am I signed in?" is a question only
 * the server can answer, and caching the answer past a revocation would be the client lying
 * about it.
 *
 * `stage` is the state machine, and it comes from the server rather than being tracked here:
 *
 *   `setup`         password accepted, two-factor not enrolled — enrolment is next
 *   `totp`          password accepted, a code is next
 *   `authenticated` both factors accepted
 *
 * A `pre` session that expires (five minutes) answers 401, which drops to the sign-in screen
 * with a reason rather than looping.
 */
export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'unreachable' }
  | { status: 'known'; me: MeResponse };

export interface Session {
  state: SessionState;
  /** Re-reads `me`. Called after every stage change and after a step-up. */
  refresh: () => Promise<void>;
  /** Forgets the local copy. The cookie is cleared by the server. */
  forget: () => void;
}

export function useSession(): Session {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      // `noRedirect`, because this call is how the client asks *whether* there is a session. A
      // 401 here is the expected answer on the sign-in screen, not a reason to redirect to it.
      const me = await api.get<MeResponse>('/api/auth/me', { noRedirect: true });
      setState({ status: 'known', me });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setState({ status: 'anonymous' });
        return;
      }
      // Anything else — the panel is down, a proxy is in the way, the container was killed. Not
      // "signed out": telling the operator to sign in when the server cannot be reached sends
      // them to type a password into a page that cannot check it.
      setState({ status: 'unreachable' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const forget = useCallback(() => setState({ status: 'anonymous' }), []);

  return { state, refresh, forget };
}

/**
 * Stores the locale the server has on file, so the next boot's `bootstrap.js` applies it before
 * first paint.
 *
 * The client cannot read the stored value before it has a session, and `bootstrap.js` must not
 * read the database on an unauthenticated route — so this is the bridge between the two: once
 * `me` is known, the answer is cached where the pre-paint script looks for it.
 */
export function cacheStoredLocale(locale: 'en' | 'fa' | null): void {
  if (locale === null) return;
  try {
    window.localStorage.setItem('panel.locale', locale);
  } catch {
    /* storage unavailable; the guess from Accept-Language stands */
  }
}
