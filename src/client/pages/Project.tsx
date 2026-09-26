import { useEffect, useState } from 'react';
import { Badge, Card, Notice } from '../components/ui.js';
import { KeyValueTable } from '../components/Table.js';
import { Ltr } from '../components/Ltr.js';
import { Time } from '../components/Time.js';
import { useLocale } from '../i18n/index.js';
import { ApiError, getProject } from '../lib/api.js';
import { PROJECT_SUMMARY_TABLE } from '../lib/table.js';
import type { TranslationKey } from '../i18n/en.js';
import type { ProjectDto } from '../../shared/types.js';

/**
 * One project, addressed by its uuid.
 *
 * ── The address is the uuid, and only the uuid ──────────────────────────────
 * `/projects/<uuid>`. The slug is rendered as the heading and as a label, and appears in no
 * request path and no link: a rename is a database write, so it must never be able to invalidate
 * a URL somebody has open, a bookmark, or the tab the operator is reading.
 *
 * ── Six tabs, five of them not built ────────────────────────────────────────
 * An unbuilt capability is a **disabled tab** rather than a missing one, so the shape of the
 * screen tells the operator what is coming and where. The pattern is the ARIA one for a tablist
 * with unavailable tabs: `aria-disabled="true"` and never the `disabled` attribute, because
 * `disabled` takes the control out of the tab order and a screen-reader user would then never
 * learn the tab exists. Each of them carries one shared `aria-describedby` pointing at a single
 * visually hidden sentence, so the reason is announced with the tab rather than published six
 * times on the page.
 *
 * There is no roving tabindex. Exactly one panel exists, so arrow-key movement between six
 * controls that all do nothing would be a keyboard interaction that leads nowhere; every tab is
 * in the natural Tab order and the one real tab owns the panel through `aria-controls`.
 */
export function Project({
  uuid,
  navigate,
}: {
  uuid: string;
  navigate: (path: string) => void;
}): React.JSX.Element {
  const { t, ts } = useLocale();
  const [project, setProject] = useState<ProjectDto | null>(null);
  /** The closed set of ways this screen fails, so the render never invents a message. */
  const [failure, setFailure] = useState<'not_found' | 'network' | null>(null);

  useEffect(() => {
    let live = true;
    setProject(null);
    setFailure(null);
    getProject(uuid)
      .then((found) => {
        if (live) setProject(found);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setFailure(err instanceof ApiError && err.code === 'not_found' ? 'not_found' : 'network');
      });
    return () => {
      live = false;
    };
  }, [uuid]);

  if (failure === 'not_found') {
    return (
      <>
        <h1>{t('project.notFound')}</h1>
        <p className="lede">{t('projects.explain')}</p>
        <div className="row">
          <button type="button" className="btn" onClick={() => navigate('/')}>
            {t('nav.projects')}
          </button>
        </div>
      </>
    );
  }

  if (failure !== null) {
    return (
      <>
        <h1>{t('projects.title')}</h1>
        <Notice kind="danger">{t('error.network')}</Notice>
      </>
    );
  }

  if (project === null) {
    return (
      <>
        <h1>{t('projects.title')}</h1>
        <p className="lede">{t('common.loading')}</p>
      </>
    );
  }

  return (
    <>
      <h1>
        <Ltr>{project.slug}</Ltr>
      </h1>

      <div className="tablist" role="tablist" aria-label={ts('project.tabs')}>
        <button
          type="button"
          role="tab"
          id="tab-summary"
          className="tab tab-on"
          aria-selected="true"
          aria-controls="panel-summary"
        >
          {t('project.tabSummary')}
        </button>
        {UNBUILT.map(([key, milestone]) => (
          <button
            key={milestone}
            type="button"
            role="tab"
            className="tab"
            aria-selected="false"
            aria-disabled="true"
            aria-describedby="tab-unbuilt"
          >
            {t(key, { milestone })}
          </button>
        ))}
      </div>
      <p id="tab-unbuilt" className="visually-hidden">
        {t('project.tabSoon')}
      </p>

      <div
        className="tabpanel"
        role="tabpanel"
        id="panel-summary"
        aria-labelledby="tab-summary"
        tabIndex={0}
      >
        <Card wide>
          <KeyValueTable
            spec={PROJECT_SUMMARY_TABLE}
            rows={[
              { key: 'slug', label: t('projects.colSlug'), value: <Ltr>{project.slug}</Ltr> },
              { key: 'uuid', label: t('projects.colUuid'), value: <Ltr>{project.uuid}</Ltr> },
              {
                key: 'created',
                label: t('projects.colCreated'),
                value: <Time iso={project.createdAt} />,
              },
              {
                key: 'updated',
                label: t('project.fieldUpdated'),
                value: <Time iso={project.updatedAt} />,
              },
              {
                key: 'settings',
                label: t('projects.colSettings'),
                value: (
                  <Badge kind={project.isolatedSettings ? 'ok' : 'default'}>
                    {project.isolatedSettings ? t('projects.isolated') : t('projects.shared')}
                  </Badge>
                ),
              },
            ]}
          />
          <p className="hint">{t('project.slugIsLabel')}</p>
        </Card>
      </div>
    </>
  );
}

/** The tabs that are specified but not built: the label key and the milestone that builds it. */
const UNBUILT: readonly (readonly [TranslationKey, string])[] = [
  ['project.tabFiles', 'M2.3'],
  ['project.tabPortability', 'M2.4'],
  ['project.tabTelegram', 'M2.5'],
  ['project.tabSettings', 'M2.6'],
  ['project.tabImport', 'M2.8'],
  ['project.tabTerminal', 'M3'],
];
