import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError, requireFullSession, requireStepUp } from '../plugins/auth.js';
import type { AuthRuntime } from '../services/auth-runtime.js';
import { AuditEvent } from '../services/audit.service.js';
import {
  DiskGuardRefusedError,
  ProjectStoreError,
  type ProjectStoreService,
} from '../services/project-store.service.js';
import {
  ProjectNotFoundError,
  SlugError,
  normalizeSlug,
  type ProjectsRepository,
} from '../services/projects.service.js';
import { clientIpForDisplay, userAgentForDisplay } from '../utils/client-ip.js';
import { parseBody, projectCreateBody, projectPatchBody } from '../utils/zod-schemas.js';
import type { ProjectDto, ProjectListResponse } from '../../shared/types.js';

/**
 * Project lifecycle: list, create, read, patch, delete.
 *
 * ── A uuid in the path is validated first, and a bad one is a 404 ────────────
 *
 * An unknown uuid and a malformed uuid answer *identically*: `404` with
 * `{"error":"Not Found","code":"not_found"}`. `400` for "that is not uuid-shaped"
 * would tell a caller which of two things they got wrong, which is a fact about the
 * schema rather than about the panel's state, and it turns a probe into an oracle.
 *
 * The check is therefore the first statement of every `:uuid` handler, and it is a
 * plain expression rather than a `zod` schema because a zod `max()` on the parameter
 * would answer `400` for an over-long path segment and re-open exactly the
 * distinction the 404 closes. Everything auth-shaped — session level, step-up, CSRF,
 * `Origin` — runs before the handler, so this is only ever reached by a caller who
 * already passed them.
 *
 * ── What every mutation writes, and how it stays one unit ───────────────────
 *
 * Each successful mutation appends exactly one audit row; the disk-guard refusal
 * appends `project.create_refused`. **The route never writes the success row
 * itself.** It hands a callback to the service, and the service runs that callback
 * inside the same better-sqlite3 transaction as the row it is committing:
 *
 * - `ProjectStoreService.create` — INSERT, then the append, then COMMIT. The
 *   filesystem work (staging, `rename(2)`, quarantine) stays *before* that
 *   transaction, because holding SQLite's write lock across recursive syscalls
 *   would block every other writer; a failure inside the transaction is answered
 *   by quarantining the already-promoted tree, which is the one piece of state the
 *   rollback cannot undo.
 * - `ProjectsRepository.update` — the update and the append, one transaction.
 * - `ProjectStoreService.delete` — secret delete, row delete, append; the
 *   filesystem delete stays after COMMIT, so a crash between the two leaves an
 *   already-audited rowless directory that `diagnoseProjectDirs()` can name.
 *
 * The consequence worth stating: **a throw from the append rolls the mutation
 * back**, so there is no crash window and no failure path that leaves a mutation
 * without its required row, and none that leaves a row without the mutation. It
 * also means `audit.write` throwing is indistinguishable, from the route's side,
 * from the database failing — which is why both become the same generic 500.
 *
 * `project.create_refused` has no such requirement: the refusal is the first
 * statement of `create()`, it mutates nothing, and the route appends the row
 * before it throws the 507.
 *
 * ── Nothing here may say where anything is ───────────────────────────────────
 *
 * The data root, `projects/<uuid>`, `workspace/`, `claude-home/`, `project.json`,
 * a byte figure, an errno and a raw exception message are all things this route must
 * never put in a body or a log line. The response is the shared {@link ProjectDto} —
 * exactly the columns migration 012 owns — and a failure that is not one of the
 * three named ones is mapped by {@link failed} onto a closed code with only a phase
 * name in the log.
 */
export default async function projectRoutes(
  app: FastifyInstance,
  opts: {
    runtime: AuthRuntime;
    projects: ProjectsRepository;
    projectStore: ProjectStoreService;
  },
): Promise<void> {
  const { runtime, projects, projectStore } = opts;

  const who = (
    req: FastifyRequest,
  ): { actorIp: string | null; userAgent: string | null } => ({
    actorIp: clientIpForDisplay(req),
    userAgent: userAgentForDisplay(req),
  });

  /**
   * Canonical lowercase uuid, or a 404.
   *
   * Lowercased before the test so `ABCDEF00-…` and `abcdef00-…` are one lookup rather
   * than two answers: RFC 4122 uuids are case-insensitive, and an uppercase input
   * finding a row while the lowercase one did not would break indistinguishability in
   * the other direction.
   */
  function uuidOf(req: FastifyRequest): string {
    const { uuid } = req.params as { uuid: string };
    const canonical = uuid.toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(canonical)) {
      throw notFound();
    }
    return canonical;
  }

  function notFound(): HttpError {
    return new HttpError(404, 'no such project');
  }

  /**
   * The one place a project failure becomes a response.
   *
   * **The message is dropped, not forwarded.** A filesystem error quotes a path, an
   * errno and often a row; the rule in this panel is generic codes only. What goes to
   * the log is `phase` — a closed set (`staging | rename | database | delete`, else
   * `unknown`) — and what goes to the client is `server_error`. The thrown `HttpError`
   * carries a fresh stack, so neither the original message nor its `cause` chain can
   * reach the global handler's `request failed` line either.
   */
  function failed(log: FastifyBaseLogger, err: unknown): HttpError {
    log.error({ phase: err instanceof ProjectStoreError ? err.phase : 'unknown' }, 'project operation failed');
    return new HttpError(500, 'project operation failed', 'server_error');
  }

  /** Slug grammar. `SlugError` and a schema failure both produce the same 400. */
  function slugOf(input: string): string {
    try {
      return normalizeSlug(input);
    } catch (err) {
      if (err instanceof SlugError) throw new HttpError(400, 'invalid slug');
      throw err;
    }
  }

  // ── List ────────────────────────────────────────────────────────────────────
  // A read, so no lifecycle event: a row per list request is noise and says nothing
  // an operator could act on.
  app.get(
    '/api/projects',
    { preHandler: requireFullSession },
    async (): Promise<ProjectListResponse> => ({ projects: projects.list() }),
  );

  // ── Create ──────────────────────────────────────────────────────────────────
  app.post(
    '/api/projects',
    { preHandler: requireFullSession },
    async (req, reply): Promise<ProjectDto> => {
      const body = parseBody(projectCreateBody, req.body);

      // Grammar before the store, so the refusal row below carries a canonical slug
      // and an unvalidated request string never reaches an append-only log. This
      // reorders `ProjectStoreService.create` (which guards the disk first) without
      // weakening it: a bad slug creates nothing either way, so which one is rejected
      // first is not a property anyone can observe.
      const slug = slugOf(body.slug);

      // Allocated here and handed to the store so the refusal row can name the
      // identity the request was for. Nothing exists under it until `create()` runs.
      const uuid = randomUUID();

      try {
        const created = projectStore.create(
          {
            slug,
            uuid,
            ...(body.isolatedSettings !== undefined
              ? { isolatedSettings: body.isolatedSettings }
              : {}),
          },
          (result) =>
            runtime.audit.write({
              event: AuditEvent.ProjectCreated,
              outcome: 'success',
              ...who(req),
              // `renamed` matters on create: the request's slug may have collided, and a
              // row that records only the stored slug would hide that the label changed.
              meta: { uuid, slug: result.project.slug, renamed: result.renamed },
            }),
        );

        reply.code(201);
        return created.project;
      } catch (err) {
        if (err instanceof DiskGuardRefusedError) {
          // Closed reason code only — no threshold, no free/total/used figure, no path,
          // no errno, no raw message. The figures are exactly what a client must not
          // learn; the operator gets `insufficient_storage` in the same breath.
          runtime.audit.write({
            event: AuditEvent.ProjectCreateRefused,
            outcome: 'failure',
            ...who(req),
            meta: { uuid, slug, reason: 'disk_guard' },
          });
          throw new HttpError(507, 'insufficient disk space', 'insufficient_storage');
        }
        if (err instanceof SlugError) throw new HttpError(400, 'invalid slug');
        throw failed(req.log, err);
      }
    },
  );

  // ── Read one ────────────────────────────────────────────────────────────────
  app.get(
    '/api/projects/:uuid',
    { preHandler: requireFullSession },
    async (req): Promise<ProjectDto> => {
      const project = projects.getByUuid(uuidOf(req));
      if (project === null) throw notFound();
      return project;
    },
  );

  // ── Patch: slug and/or isolatedSettings ─────────────────────────────────────
  app.patch(
    '/api/projects/:uuid',
    { preHandler: requireFullSession },
    async (req): Promise<ProjectDto> => {
      const uuid = uuidOf(req);
      const before = projects.getByUuid(uuid);
      if (before === null) throw notFound();

      const body = parseBody(projectPatchBody, req.body);
      const slug = body.slug === undefined ? undefined : slugOf(body.slug);

      try {
        const updated = projects.update(
          uuid,
          {
            ...(slug !== undefined ? { slug } : {}),
            ...(body.isolatedSettings !== undefined
              ? { isolatedSettings: body.isolatedSettings }
              : {}),
          },
          (result) =>
            runtime.audit.write({
              event: AuditEvent.ProjectUpdated,
              outcome: 'success',
              ...who(req),
              meta: {
                uuid,
                slug: result.project.slug,
                previousSlug: before.slug,
                isolatedSettings: result.project.isolatedSettings,
                // Whether the label actually moved — not the repository's `renamed`,
                // which means "the slug I asked for was taken and got a suffix". A
                // slug-only PATCH with a free slug changes the label while that flag
                // stays false, and this row is what has to say which field moved.
                renamed: result.project.slug !== before.slug,
              },
            }),
        );

        return updated.project;
      } catch (err) {
        if (err instanceof SlugError) throw new HttpError(400, 'invalid slug');
        throw failed(req.log, err);
      }
    },
  );

  // ── Delete ──────────────────────────────────────────────────────────────────
  //
  // Step-up, and this route owns the choice: deletion is irreversible and destroys a
  // directory, so a full session that has not re-confirmed in five minutes is not
  // enough. A caller with no session still gets the ordinary `401`, never a
  // `step_up_required`, because `requireStepUp` answers 401 before it reaches the
  // level test — so a stranger learns nothing about this route from the body.
  app.delete(
    '/api/projects/:uuid',
    { preHandler: requireStepUp(runtime) },
    async (req, reply) => {
      const uuid = uuidOf(req);
      const existing = projects.getByUuid(uuid);
      if (existing === null) throw notFound();

      try {
        projectStore.delete(uuid, () =>
          runtime.audit.write({
            event: AuditEvent.ProjectDeleted,
            outcome: 'success',
            ...who(req),
            meta: { uuid, slug: existing.slug },
          }),
        );
      } catch (err) {
        // Lost a race with a concurrent delete: the row we just read is gone.
        if (err instanceof ProjectNotFoundError) throw notFound();
        throw failed(req.log, err);
      }

      return reply.code(204).send();
    },
  );
}
