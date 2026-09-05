import { Link, useRouter, type Route } from './lib/router.js';
import { useLocale, LOCALES } from './i18n/index.js';
import { Button } from './components/ui.js';
import { api } from './lib/api.js';
import { Audit } from './pages/Audit.js';
import { Overview } from './pages/Overview.js';
import { Secrets } from './pages/Secrets.js';
import { Security } from './pages/Security.js';
import { Sessions } from './pages/Sessions.js';
import type { MeResponse } from '../shared/types.js';

/**
 * The shell: navigation, the signed-in identity, sign out, and the language switch.
 *
 * **No command palette.** It has nothing to search until there are projects — the only things it
 * could offer are the five links already on screen — and a palette that lists five links teaches
 * the operator that it is not worth opening. Recorded for M2.2, where projects give it something
 * to find.
 *
 * Three things a frame has to get right, and all three are keyboard or screen-reader properties
 * that a mouse never exercises: a skip link that is reachable (off-screen, never
 * `display: none`, which would take it out of the tab order), navigation whose current item is
 * *announced* through `aria-current` rather than only coloured, and a `<main>` that can take
 * focus so a navigation lands somewhere.
 */
export function Shell({
  me,
  onSignedOut,
  refresh,
}: {
  me: MeResponse;
  onSignedOut: () => void;
  refresh: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useLocale();
  const { route, path, navigate } = useRouter();

  // Called from two places: the button below, and the current session's row on the sessions
  // screen — where "revoke this session" is a sign-out and must go through the endpoint that
  // clears the cookie rather than through `DELETE /api/sessions/:id`, which would leave the tab
  // holding a dead cookie until its next request 401s.
  const signOut = async (): Promise<void> => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      // Locally forgotten either way: the cookie is already gone from the server's point of
      // view, and a failed logout must not leave the operator looking at a signed-in shell.
      onSignedOut();
    }
  };

  return (
    <div className="shell">
      <a className="skip" href="#main">
        {t('nav.skipToContent')}
      </a>
      <div className="side">
        <span className="brand">{t('app.name')}</span>
        <nav aria-label={useLocale().ts('app.name')}>
          <Link to="/" navigate={navigate} ariaCurrent={path === '/'}>
            {t('nav.overview')}
          </Link>
          <Link to="/sessions" navigate={navigate} ariaCurrent={route.name === 'sessions'}>
            {t('nav.sessions')}
          </Link>
          <Link to="/security" navigate={navigate} ariaCurrent={route.name === 'security'}>
            {t('nav.security')}
          </Link>
          <Link to="/secrets" navigate={navigate} ariaCurrent={route.name === 'secrets'}>
            {t('nav.secrets')}
          </Link>
          <Link to="/audit" navigate={navigate} ariaCurrent={route.name === 'audit'}>
            {t('nav.audit')}
          </Link>
        </nav>
        <div className="identity">
          <span>{t('app.signedInAs', { username: me.username })}</span>
          <LocaleSwitch />
          <Button onClick={() => void signOut()}>{t('app.signOut')}</Button>
        </div>
      </div>
      {/* `tabIndex={-1}` so the skip link and every navigation can move focus here. */}
      <main className="main" id="main" tabIndex={-1}>
        {/* The routed region, and **keyed by the route and by nothing else**. The key is what
            makes the enter animation in §*Motion* run on a navigation; a key carrying any
            polled value would remount this subtree every two seconds and replay the animation
            while the operator was reading it. `docs/UI.md` §*Motion* states the rule and
            `tests/integration/client-style.test.ts` asserts this line. */}
        <div className="screen" key={route.name}>
          <Screen
            route={route}
            refresh={refresh}
            navigate={navigate}
            me={me}
            onSignOut={() => void signOut()}
          />
        </div>
      </main>
    </div>
  );
}

/**
 * The language switch, which is the one setting the client may write.
 *
 * `PATCH /api/settings/locale` needs a full session, so this is the authenticated half of the
 * same control the sign-in screen offers client-side. The local change is applied first and the
 * request follows: the operator's language must not wait on a round trip, and a failed write
 * costs them the *persistence* of the choice rather than the choice.
 */
function LocaleSwitch(): React.JSX.Element {
  const { t, ts, locale, setLocale } = useLocale();
  return (
    <div className="row" role="radiogroup" aria-label={ts('common.language')}>
      {LOCALES.map((candidate) => (
        <button
          key={candidate}
          type="button"
          role="radio"
          aria-checked={locale === candidate}
          className={locale === candidate ? 'chip chip-on' : 'chip'}
          onClick={() => {
            setLocale(candidate);
            void api.patch('/api/settings/locale', { locale: candidate }).catch(() => {
              /* the choice still applies to this browser; only the stored copy is missing */
            });
          }}
        >
          {candidate === 'en' ? t('common.english') : t('common.persian')}
        </button>
      ))}
    </div>
  );
}

function Screen({
  route,
  refresh,
  me,
  onSignOut,
}: {
  route: Route;
  refresh: () => Promise<void>;
  navigate: (path: string) => void;
  me: MeResponse;
  onSignOut: () => void;
}): React.JSX.Element {
  const { t } = useLocale();
  switch (route.name) {
    case 'overview':
      return <Overview />;
    case 'sessions':
      return <Sessions onSignOut={onSignOut} />;
    case 'security':
      return <Security me={me} refresh={refresh} />;
    case 'secrets':
      return <Secrets />;
    case 'audit':
      return <Audit />;
    default:
      // The client's own not-found screen, not the server's. A hard refresh of this path was
      // answered with the shell (Part 1) precisely so this screen is what renders.
      return (
        <>
          <h1>{t('notFound.title')}</h1>
          <p className="lede">{t('notFound.explain')}</p>
        </>
      );
  }
}
