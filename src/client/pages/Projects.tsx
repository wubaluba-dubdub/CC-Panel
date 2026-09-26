import { useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, Field, Notice } from '../components/ui.js';
import { DataTable, type DataRow } from '../components/Table.js';
import { Ltr } from '../components/Ltr.js';
import { Time } from '../components/Time.js';
import { Link, projectPath } from '../lib/router.js';
import { useLocale } from '../i18n/index.js';
import { ApiError, createProject, deleteProject, updateProject } from '../lib/api.js';
import { PROJECTS_TABLE, type ProjectColumnKey } from '../lib/table.js';
import type { ProjectDto } from '../../shared/types.js';

/**
 * The home screen: every project, and the three things that can be done to one.
 *
 * ── Seven fields, and nothing else ──────────────────────────────────────────
 * A row is built from `ProjectDto` exactly — `slug`, `uuid`, `createdAt`,
 * `isolatedSettings` — and nothing else, because the DTO is the whole contract the server
 * promised. A `displayName` or a path here would be a field the API does not return and a
 * screen that renders `undefined` with a straight face.
 *
 * ── The slug is a label, so the address is a uuid ───────────────────────────
 * The name cell links to `projectPath(uuid)`. Renaming a project rewrites the slug and never
 * the uuid, so no link, no tab and no request in this panel can be invalidated by a rename.
 *
 * ── What a refusal looks like ───────────────────────────────────────────────
 * The server refuses creation with `insufficient_storage` when the volume is full. The copy is
 * generic in both languages: a path, a threshold or a byte count would turn a full disk into a
 * capacity disclosure, and the operator's next move (free some space) does not need one.
 */
export function Projects({
  projects,
  error,
  reload,
  createIntent,
  navigate,
}: {
  /** Null only while the first list request is in flight. */
  projects: readonly ProjectDto[] | null;
  error: boolean;
  reload: () => void;
  /** Bumped by the command palette so "create a project" lands focus in the form. */
  createIntent: number;
  navigate: (path: string) => void;
}): React.JSX.Element {
  const { t } = useLocale();
  const [slug, setSlug] = useState('');
  const [isolated, setIsolated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<React.ReactNode | null>(null);
  const [failure, setFailure] = useState<React.ReactNode | null>(null);
  /** Rename drafts, keyed by uuid: a table row that loses its text on every poll is unusable. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** The one project whose delete dialog is open, or null. */
  const [confirming, setConfirming] = useState<ProjectDto | null>(null);

  useEffect(() => {
    if (createIntent > 0) document.getElementById('new-project-slug')?.focus();
  }, [createIntent]);

  const describe = (err: unknown): React.ReactNode => {
    if (err instanceof ApiError) {
      switch (err.code) {
        case 'insufficient_storage':
          return t('error.insufficientStorage');
        case 'not_found':
          return t('error.notFound');
        default:
          return t('error.unknown');
      }
    }
    return t('error.network');
  };

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await work();
    } catch (err) {
      // A cancelled step-up is the operator changing their mind, not a failure to report.
      if (!(err instanceof ApiError && err.code === 'step_up_required')) setFailure(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = (event: React.FormEvent): void => {
    event.preventDefault();
    void run(async () => {
      const created = await createProject({ slug, isolatedSettings: isolated });
      setNotice(
        created.renamed
          ? t('projects.createdAdjusted', { requested: slug, slug: created.slug })
          : t('projects.created', { slug: created.slug }),
      );
      setSlug('');
      setIsolated(false);
      reload();
    });
  };

  const rename = (project: ProjectDto): void => {
    const requested = drafts[project.uuid] ?? project.slug;
    if (requested === project.slug) return;
    void run(async () => {
      const updated = await updateProject(project.uuid, { slug: requested });
      // The server resolves collisions with a `-N` suffix and normalises case; only a slug that
      // differs from what was asked for (after the same two normalisations) is an adjustment.
      if (updated.slug !== requested.normalize('NFC').toLowerCase()) {
        setNotice(t('projects.slugAdjusted', { requested, slug: updated.slug }));
      } else if (updated.renamed) {
        setNotice(t('projects.slugSaved', { slug: updated.slug }));
      }
      reload();
    });
  };

  /** Toggling is the save: one control, one request, no "did I remember to apply it" state. */
  const toggleSettings = (project: ProjectDto, next: boolean): void => {
    void run(async () => {
      await updateProject(project.uuid, { isolatedSettings: next });
      setNotice(t('projects.settingsSaved'));
      reload();
    });
  };

  const remove = (project: ProjectDto): void => {
    void run(async () => {
      await deleteProject(project.uuid);
      setConfirming(null);
      setNotice(t('projects.deleted', { slug: project.slug }));
      reload();
    });
  };

  const rows: DataRow<ProjectColumnKey>[] = (projects ?? []).map((project) => ({
    id: project.uuid,
    cells: {
      'projects.colSlug': (
        <Link to={projectPath(project.uuid)} navigate={navigate}>
          <Ltr>{project.slug}</Ltr>
        </Link>
      ),
      'projects.colUuid': <Ltr>{project.uuid}</Ltr>,
      'projects.colCreated': <Time iso={project.createdAt} />,
      'projects.colSettings': (
        <Badge kind={project.isolatedSettings ? 'ok' : 'default'}>
          {project.isolatedSettings ? t('projects.isolated') : t('projects.shared')}
        </Badge>
      ),
    },
    detail: (
      <div className="stack">
        <div className="row">
          <Field
            id={`rename-${project.uuid}`}
            label={t('projects.slugLabel')}
            ltr
            maxLength={40}
            value={drafts[project.uuid] ?? project.slug}
            onChange={(next) => setDrafts({ ...drafts, [project.uuid]: next })}
          />
          <Button onClick={() => rename(project)} disabled={busy}>
            {t('projects.rename')}
          </Button>
        </div>
        <p className="hint">{t('project.slugIsLabel')}</p>
        <div className="field">
          <label htmlFor={`isolated-${project.uuid}`}>
            <input
              id={`isolated-${project.uuid}`}
              type="checkbox"
              checked={project.isolatedSettings}
              disabled={busy}
              onChange={(event) => toggleSettings(project, event.target.checked)}
            />{' '}
            {t('projects.isolatedLabel')}
          </label>
        </div>
        <div className="row">
          <Button onClick={() => setConfirming(project)} kind="danger" disabled={busy}>
            {t('projects.delete')}
          </Button>
        </div>
      </div>
    ),
  }));

  return (
    <>
      <h1>{t('projects.title')}</h1>
      <p className="lede">{t('projects.explain')}</p>

      {failure === null ? null : <Notice kind="danger">{failure}</Notice>}
      {notice === null ? null : <Notice kind="ok" live>{notice}</Notice>}
      {error ? <Notice kind="danger">{t('error.network')}</Notice> : null}

      {projects === null ? (
        <Card wide>
          <DataTable spec={PROJECTS_TABLE} rows={[]} loading />
        </Card>
      ) : projects.length === 0 ? (
        /* Zero rows is a sentence and a form, not a table with an empty body: a header row over
           nothing reads as a panel that failed to load. */
        <Card>
          <p>{t('projects.empty')}</p>
        </Card>
      ) : (
        <Card wide>
          <DataTable spec={PROJECTS_TABLE} rows={rows} empty={t('projects.empty')} />
        </Card>
      )}

      <Card title={t('projects.create')}>
        <form onSubmit={submitCreate} className="stack">
          <Field
            id="new-project-slug"
            label={t('projects.slugLabel')}
            ltr
            maxLength={40}
            value={slug}
            onChange={setSlug}
            hint={t('projects.slugHint')}
          />
          <div className="field">
            <label htmlFor="new-project-isolated">
              <input
                id="new-project-isolated"
                type="checkbox"
                checked={isolated}
                onChange={(event) => setIsolated(event.target.checked)}
              />{' '}
              {t('projects.isolatedLabel')}
            </label>
          </div>
          <div className="row">
            <Button kind="primary" disabled={busy} type="submit">
              {t('projects.create')}
            </Button>
          </div>
        </form>
      </Card>

      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={t('projects.deleteTitle', { slug: confirming?.slug ?? '' })}
      >
        <Notice kind="danger">{t('projects.deleteWarn')}</Notice>
        <div className="row">
          <Button
            kind="danger"
            disabled={busy}
            onClick={() => {
              if (confirming !== null) remove(confirming);
            }}
          >
            {t('projects.deleteConfirm')}
          </Button>
          <Button onClick={() => setConfirming(null)} disabled={busy}>
            {t('common.cancel')}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
