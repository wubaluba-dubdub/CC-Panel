/**
 * The identity shape a project's URL, its workspace directory and its secret AAD
 * all agree on.
 *
 * Here rather than in `services/project-store.service.ts` because both halves of the
 * panel need it and neither may import the other: the server validates a uuid before
 * joining it into a path, and the client accepts it as the last path segment of
 * `/projects/<uuid>`. One definition means "what counts as a project id" cannot drift
 * between the two — a stricter server and a looser client would otherwise disagree
 * about a link the panel itself produced.
 *
 * Canonical lowercase hex, exactly as `crypto.randomUUID()` emits it. Anything else —
 * empty, `:`, `/`, `.`, `..`, NUL, uppercase — fails before the string is joined into
 * anything.
 */
export const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
