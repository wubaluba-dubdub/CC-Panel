import { useCallback, useEffect, useState } from 'react';
import { Link, useRouter, type Route } from './lib/router.js';
import { useLocale, LOCALES } from './i18n/index.js';
import { Button } from './components/ui.js';
import { CommandPalette } from './components/CommandPalette.js';
import { Ltr } from './components/Ltr.js';
import { api, listProjects } from './lib/api.js';
import { Audit } from './pages/Audit.js';
import { Overview } from './pages/Overview.js';
import { Project } from './pages/Project.js';
import { Projects } from './pages/Projects.js';
import { Secrets } from './pages/Secrets.js';
import { Security } from './pages/Security.js';
import { Sessions } from './pages/Sessions.js';
import type { AuthenticatedMe, ProjectDto } from '../shared/types.js';

/**
 * The shell: navigation, the signed-in identity, sign out, the language switch, the project
 * list the home screen and the palette share, and the command palette itself.
 *
 * ── Why the project list lives here ─────────────────────────────────────────
 * Two screens want it: the home screen renders it, and the palette searches it. One request on
 * mount, one `reload()` after any create/rename/delete, and both consumers read the same array —
 * so a mutation cannot leave the palette offering a project that has just been deleted.
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
  me: AuthenticatedMe;
  onSignedOut: () => void;
  refresh: () => Promise<void>;
}): React.JSX.Element {
  const { t, ts } = useLocale();
  const { route, path, navigate } = useRouter();
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  /** Counted, not boolean: a second "create" while already on the home screen must refocus. */
  const [createIntent, setCreateIntent] = useState(0);

  const loadProjects = useCallback(async () => {
    try {
      const res = await listProjects();
      setProjects(res.projects);
      setListFailed(false);
    } catch {
      // Keep whatever was on screen: a stale list behind an error notice is more useful than an
      // empty list that says the panel has no projects.
      setListFailed(true);
      setProjects((previous) => previous ?? []);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Called from three places: the sign-out button below, the current session's row on the
  // sessions screen, and the command palette — where all three mean the same thing and must go
  // through the endpoint that clears the cookie rather than through `DELETE /api/sessions/:id`.
  const signOut = async (): Promise<void> => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      onSignedOut();
    }
  };

  const requestCreate = useCallback(() => {
    navigate('/');
    setCreateIntent((count) => count + 1);
  }, [navigate]);

  return (
    <div className="shell">
      <a className="skip" href="#main">
        {t('nav.skipToContent')}
      </a>
      <div className="side">
        <span className="brand">{t('app.name')}</span>
        <nav aria-label={ts('app.name')}>
          <Link to="/" navigate={navigate} ariaCurrent={path === '/'}>
            {t('nav.projects')}
          </Link>
          <Link to="/overview" navigate={navigate} ariaCurrent={route.name === 'overview'}>
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
          {/* The build id, only here. `AuthenticatedMe` is the shape this component is handed —
              `App.tsx` narrows on `stage === 'authenticated'` before it passes anything — and
              `MeResponse` for a `pre` session has no `buildId` member to forget to delete. The
              pre-login shell, `bootstrap.js` and every static asset hold neither. */}
          {me.buildId === null ? null : (
            <span className="hint">{t('app.buildId', { id: <Ltr>{me.buildId}</Ltr> })}</span>
          )}
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
            projects={projects}
            listFailed={listFailed}
            reloadProjects={() => void loadProjects()}
            createIntent={createIntent}
          />
        </div>
      </main>
      <CommandPalette
        projects={projects ?? []}
        navigate={navigate}
        onCreate={requestCreate}
        onSignOut={() => void signOut()}
      />
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
  navigate,
  me,
  onSignOut,
  projects,
  listFailed,
  reloadProjects,
  createIntent,
}: {
  route: Route;
  refresh: () => Promise<void>;
  navigate: (path: string) => void;
  me: AuthenticatedMe;
  onSignOut: () => void;
  projects: readonly ProjectDto[] | null;
  listFailed: boolean;
  reloadProjects: () => void;
  createIntent: number;
}): React.JSX.Element {
  const { t } = useLocale();
  switch (route.name) {
    case 'projects':
      return (
        <Projects
          projects={projects}
          error={listFailed}
          reload={reloadProjects}
          createIntent={createIntent}
          navigate={navigate}
        />
      );
    case 'project':
      return <Project uuid={route.uuid} navigate={navigate} />;
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
