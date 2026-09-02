/**
 * The panel refuses to serve as root, and proves it cannot become root.
 *
 * Two separate failures, both of which the container arrangement in `entrypoint.sh`
 * is designed to prevent and neither of which should be discovered by its
 * consequences:
 *
 * 1. **Running as uid 0.** Phase 3 spawns agent processes — a shell in a pty, a
 *    Claude Code CLI, whatever the operator points it at — as children of this
 *    process. A panel that executes them as root turns every one of them into a
 *    root shell. The entrypoint drops to 10001 before `exec`ing the server, so the
 *    only way to arrive here as root is that the drop did not happen, and the right
 *    response to that is not to serve.
 * 2. **Running as 10001 but still able to return to 0.** This is the subtle one.
 *    `setuid()`-style drops come in two shapes: `setresuid(ruid, euid, suid)` with
 *    the *saved* id also set, which is permanent, and one that leaves the saved id at
 *    0, which is an invitation — the process can call `setuid(0)` and get root back.
 *    "Drops privileges" is exactly the kind of claim that is easy to get subtly
 *    wrong, so it is tested rather than asserted, at boot, on the real process.
 *
 * The probe is injected so the property can be exercised without a container and
 * without being root: the suite drives all four shapes (no uid support, root,
 * a permanent drop, a reversible one).
 */

export class PrivilegeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivilegeError';
  }
}

export interface PrivilegeProbe {
  getuid?: (() => number) | undefined;
  geteuid?: (() => number) | undefined;
  setuid?: ((id: number) => void) | undefined;
}

export type PrivilegeCheck =
  /** No uid concept on this platform. Nothing to assert, nothing to hide. */
  | { supported: false }
  | { supported: true; uid: number; euid: number; rootReachable: boolean };

export const PANEL_UID = 10001;

/**
 * Asserts the process is unprivileged and cannot regain privilege, or throws.
 *
 * The `setuid(0)` attempt is safe, which is worth spelling out because it looks
 * reckless. If it fails — the expected outcome — nothing happened. If it succeeds,
 * the process was *already* one syscall away from root, so discovering that is
 * strictly better than not; and dropping straight back with `setuid(originalUid)`
 * while euid is 0 sets the real, effective **and saved** ids at once, which is the
 * permanent drop that was missing. Either way the process ends up unprivileged, and
 * in the second case it also refuses to serve.
 */
export function assertUnprivileged(probe: PrivilegeProbe = process): PrivilegeCheck {
  const { getuid, geteuid, setuid } = probe;
  if (typeof getuid !== 'function') return { supported: false };

  const uid = getuid();
  const euid = typeof geteuid === 'function' ? geteuid() : uid;

  if (uid === 0 || euid === 0) {
    throw new PrivilegeError(
      `FATAL: the panel is running as root (uid ${uid}, euid ${euid}) and refuses to serve. ` +
        'It spawns agent processes as its own children, so running as root would make ' +
        'every one of them a root process. In the container this cannot happen: ' +
        'entrypoint.sh starts as root only long enough to fix ownership of the volume, ' +
        `then execs the server as uid ${PANEL_UID}. If you are seeing this, the ` +
        'entrypoint was bypassed — check that ENTRYPOINT is still ["/entrypoint.sh"] ' +
        'and that nothing overrode it with a bare `node dist/server/index.js`.',
    );
  }

  if (typeof setuid !== 'function') return { supported: true, uid, euid, rootReachable: false };

  let rootReachable = false;
  try {
    setuid(0);
    rootReachable = true;
  } catch {
    // The expected path: EPERM. The drop was permanent.
  }

  if (rootReachable) {
    // We are root right now. Drop back before anything else can happen; while euid is
    // 0 this sets the saved id too, which is the permanence that was missing.
    let recovered = false;
    try {
      setuid(uid);
      recovered = true;
    } catch {
      // Nothing left to try. The throw below is the only correct outcome.
    }
    throw new PrivilegeError(
      `FATAL: the panel is running as uid ${uid} but can return to root, so the ` +
        'privilege drop was not permanent — the saved set-user-ID is still 0. ' +
        (recovered
          ? 'The process has dropped back to its original uid and is refusing to serve. '
          : 'The process could not drop back and is refusing to serve. ') +
        'Whatever performed the drop must set the saved uid as well: `setpriv --reuid ' +
        '--regid --clear-groups` does, a bare `setuid()` from a shell wrapper may not.',
    );
  }

  return { supported: true, uid, euid, rootReachable: false };
}
