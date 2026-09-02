import { existsSync } from 'node:fs';
import type { Env } from '../env.js';

/**
 * Which address the server binds.
 *
 * This was `0.0.0.0`, hard-coded in `index.ts`, and it was half wrong in each
 * direction. In a container it has to be the wildcard: Railway's edge reaches the
 * service over the container network, and a process listening on `127.0.0.1` is
 * unreachable from it while looking perfectly healthy in its own logs — the worst
 * shape a deployment failure can take, because nothing in the container is broken.
 * Outside a container the same value is a small, permanent mistake in the other
 * direction: a development server on the wildcard is reachable from every machine on
 * the LAN, and this one has no TLS and a session cookie without `Secure`.
 *
 * So the default depends on where the process is, and the resolution is explicit
 * rather than clever: an operator-supplied value always wins, and the only automatic
 * answers are "container or production → wildcard" and "anything else → loopback".
 */

export const WILDCARD_HOST = '0.0.0.0';
export const LOOPBACK_HOST = '127.0.0.1';

export type ListenHostSource =
  | 'PANEL_LISTEN_HOST'
  | 'container-default'
  | 'production-default'
  | 'development-default';

export interface ResolvedListenHost {
  readonly host: string;
  readonly source: ListenHostSource;
}

export interface ListenHostInputs {
  /** `PANEL_LISTEN_HOST`, when the operator set one. */
  readonly explicit?: string | undefined;
  readonly production: boolean;
  /** True when this process is running inside the panel's container image. */
  readonly inContainer: boolean;
}

/**
 * Whether we are in the panel's own container.
 *
 * `PANEL_IN_CONTAINER=1` is set by the `Dockerfile` and is the primary signal,
 * because it is a fact the image asserts about itself rather than something inferred.
 * `/.dockerenv` is a fallback for a hand-built image or a `docker run` against a base
 * image, and it is injectable so the test suite can drive both answers without
 * needing a container to be true or false.
 */
export function detectContainer(env: Env, fileExists: (path: string) => boolean = existsSync): boolean {
  if (env.PANEL_IN_CONTAINER === '1') return true;
  return fileExists('/.dockerenv');
}

export function resolveListenHost(inputs: ListenHostInputs): ResolvedListenHost {
  const explicit = inputs.explicit?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return { host: explicit, source: 'PANEL_LISTEN_HOST' };
  }
  if (inputs.inContainer) return { host: WILDCARD_HOST, source: 'container-default' };
  // Production outside a container is an unusual deployment but a real one — a bare
  // VM, a systemd unit — and there the wildcard is still the right default, for the
  // same reason it is in a container: something in front of this process needs to
  // reach it, and it is not on this machine.
  if (inputs.production) return { host: WILDCARD_HOST, source: 'production-default' };
  return { host: LOOPBACK_HOST, source: 'development-default' };
}

/** {@link resolveListenHost} with the inputs read off a validated `Env`. */
export function listenHostFor(
  env: Env,
  fileExists?: (path: string) => boolean,
): ResolvedListenHost {
  return resolveListenHost({
    ...(env.PANEL_LISTEN_HOST !== undefined ? { explicit: env.PANEL_LISTEN_HOST } : {}),
    production: env.NODE_ENV === 'production',
    inContainer: detectContainer(env, fileExists),
  });
}
