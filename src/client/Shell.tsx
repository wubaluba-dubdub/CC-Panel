import { Link, useRouter } from './lib/router.js';
import { useLocale } from './i18n/index.js';
import { Button } from './components/ui.js';
import { api } from './lib/api.js';
import type { MeResponse } from '../shared/types.js';

/**
 * Part 3's placeholder shell: navigation, the identity, sign out.
 *
 * Part 4 fills the screens in. What is here is the frame they hang on, and the three things a
 * frame has to get right: a skip link that is reachable by keyboard, navigation whose current
 * item is announced (`aria-current`) rather than merely coloured, and a `<main>` that can take
 * focus so a navigation lands somewhere for a screen reader.
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
          <Button onClick={() => void signOut()}>{t('app.signOut')}</Button>
        </div>
      </div>
      {/* `tabIndex={-1}` so the skip link and every navigation can move focus here. */}
      <main className="main" id="main" tabIndex={-1}>
        <Screen route={route} refresh={refresh} navigate={navigate} me={me} />
      </main>
    </div>
  );
}

function Screen({
  route,
}: {
  route: ReturnType<typeof useRouter>['route'];
  refresh: () => Promise<void>;
  navigate: (path: string) => void;
  me: MeResponse;
}): React.JSX.Element {
  const { t } = useLocale();
  if (route.name === 'not-found') {
    return (
      <>
        <h1>{t('notFound.title')}</h1>
        <p className="lede">{t('notFound.explain')}</p>
      </>
    );
  }
  return (
    <>
      <h1>{t(`nav.${route.name}`)}</h1>
      <p className="lede">{t('common.loading')}</p>
    </>
  );
}
