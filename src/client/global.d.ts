/**
 * What `bootstrap.js` puts on the window, and the only globals the client reads.
 *
 * Three values, and each one is here because the client must not *guess* it:
 *
 * - `__BASE__` — the secret prefix. Every request goes through `lib/api.ts`, which reads
 *   it from here; no component builds a URL.
 * - `__LOCALE__` — the first guess, from `Accept-Language` or the stored preference.
 *   Resolved server-side so `documentElement.dir` is right before first paint.
 * - `__CSRF_COOKIE__` — the *name* of the double-submit cookie. It is
 *   `__Secure-panel_csrf` over https and `panel_csrf` over loopback http, and
 *   `plugins/cookies.ts` is the only file allowed to decide which. A client that
 *   hard-coded either one would break on the other, silently, as a 403 on every mutation.
 */
declare global {
  interface Window {
    __BASE__?: string;
    __LOCALE__?: 'en' | 'fa';
    __CSRF_COOKIE__?: string;
  }
}

export {};
