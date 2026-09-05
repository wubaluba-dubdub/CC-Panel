import { useCallback, useEffect, useState } from 'react';

/**
 * The router, hand-written, and the reason is standing rule 4.
 *
 * There are five routes. React Router is ~20 kB of runtime dependency inside the container that
 * holds `PANEL_MASTER_KEY`, and its two features this panel would use — a `basename` and a
 * catch-all — are the twenty lines below. The rest of it (loaders, nested layouts, lazy route
 * modules, a data layer) is surface this panel has no use for and would have to keep auditing.
 *
 * ── The base path is stripped here and nowhere else ─────────────────────────
 *
 * Every path a component sees is *relative to the panel*: `/security`, not
 * `/<base>/security`. The prefix is added on the way out (`href`, `pushState`) and removed on
 * the way in, in this file only, which is the same rule `lib/api.ts` follows for requests. A
 * component that knew the prefix would be a component that could leak it into a link, a title
 * or a log line.
 *
 * ── Why `history.pushState` and not a hash ─────────────────────────────────
 *
 * A hash route never reaches the server, which would have made the SPA fallback unnecessary —
 * and would also have put the route in the fragment, where it is invisible to the server and
 * therefore to the audit log, and where a deep link cannot be answered with a 404 for a path
 * that does not exist. The fallback is nine lines in `app.ts`; the trade is not worth it.
 */

export type Route =
  | { name: 'overview' }
  | { name: 'sessions' }
  | { name: 'security' }
  | { name: 'secrets' }
  | { name: 'audit' }
  | { name: 'not-found'; path: string };

/** The paths, as one table, so a link and a route cannot disagree. */
export const ROUTES: { path: string; route: Route }[] = [
  { path: '/', route: { name: 'overview' } },
  { path: '/sessions', route: { name: 'sessions' } },
  { path: '/security', route: { name: 'security' } },
  { path: '/secrets', route: { name: 'secrets' } },
  { path: '/audit', route: { name: 'audit' } },
];

function base(): string {
  return window.__BASE__ ?? '';
}

/** The path *within* the panel, with the secret prefix removed. Always starts with `/`. */
export function currentPath(): string {
  const prefix = base();
  const path = window.location.pathname;
  if (prefix !== '' && path.startsWith(prefix)) {
    const rest = path.slice(prefix.length);
    return rest === '' ? '/' : rest;
  }
  return path === '' ? '/' : path;
}

export function routeFor(path: string): Route {
  // Trailing slashes are equivalent: `/sessions/` and `/sessions` are one route, because a
  // browser will produce both and a 404 for one of them is a bug the operator cannot explain.
  const normalised = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return ROUTES.find((entry) => entry.path === normalised)?.route ?? { name: 'not-found', path };
}

/** The `href` for a link: the prefix plus the path, and the only place the two are joined. */
export function hrefFor(path: string): string {
  return `${base()}${path}`;
}

export interface Navigation {
  route: Route;
  path: string;
  navigate: (path: string) => void;
}

export function useRouter(): Navigation {
  const [path, setPath] = useState<string>(currentPath);

  useEffect(() => {
    // Back and forward. Without this the address bar and the rendered screen disagree, which is
    // the bug that makes an operator distrust every other navigation.
    const onPopState = (): void => setPath(currentPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((next: string) => {
    if (next === currentPath()) return;
    window.history.pushState(null, '', hrefFor(next));
    setPath(next);
    // A screen reader announces a page change from focus, not from a URL change. Moving focus
    // to the main region is what makes keyboard navigation land somewhere after a link.
    document.getElementById('main')?.focus();
  }, []);

  return { route: routeFor(path), path, navigate };
}

/**
 * A link that navigates without a reload.
 *
 * It is a real `<a href>` with a real URL, so middle-click, copy-link and open-in-new-tab all
 * work — and a hard refresh of the result lands on the SPA fallback, which is the property Part
 * 1 exists to provide. The click handler only intercepts a plain left click, because a
 * modified click is the operator asking the browser to do something else.
 */
export function Link({
  to,
  children,
  className,
  navigate,
  ariaCurrent,
}: {
  to: string;
  children: React.ReactNode;
  className?: string;
  navigate: (path: string) => void;
  ariaCurrent?: boolean;
}): React.JSX.Element {
  return (
    <a
      href={hrefFor(to)}
      className={className}
      {...(ariaCurrent === true ? { 'aria-current': 'page' } : {})}
      onClick={(event) => {
        if (event.defaultPrevented) return;
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
