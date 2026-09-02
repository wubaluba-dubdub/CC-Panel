import { describe, expect, it } from 'vitest';
import {
  PANEL_UID,
  PrivilegeError,
  assertUnprivileged,
  type PrivilegeProbe,
} from '../../src/server/utils/privileges.js';

/**
 * M1.6 part 2.3 — the panel refuses to serve as root, and proves it cannot become root.
 *
 * "Drops privileges" is the claim in this milestone that is easiest to get subtly
 * wrong, because both outcomes look identical from the outside: a process running as
 * uid 10001 whose *saved* set-user-ID is still 0 is one syscall from root and reports
 * `uid=10001` in every log line and every `ps`. So the assertion is behavioural — the
 * boot check actually attempts `setuid(0)` and requires it to fail — and the shapes
 * are driven here with an injected probe, because the alternative is a test that can
 * only run as root inside a container.
 *
 * The four shapes: no uid concept at all; running as root; a permanent drop; a
 * reversible one. The last is the one worth having a test for.
 */

/** A probe whose `setuid` refuses, which is what a permanent drop looks like. */
function droppedPermanently(uid = PANEL_UID): PrivilegeProbe {
  return {
    getuid: () => uid,
    geteuid: () => uid,
    setuid: (id: number) => {
      throw new Error(`EPERM: setuid(${id})`);
    },
  };
}

/**
 * A probe whose `setuid` succeeds, which is what a drop that left the saved uid at 0
 * looks like. It tracks the calls so the test can prove the check dropped back rather
 * than leaving the process root.
 */
function reversibleDrop(uid = PANEL_UID): PrivilegeProbe & { calls: number[] } {
  const calls: number[] = [];
  let current = uid;
  return {
    calls,
    getuid: () => current,
    geteuid: () => current,
    setuid: (id: number) => {
      calls.push(id);
      current = id;
    },
  };
}

describe('a root process refuses to serve', () => {
  it('throws for uid 0', () => {
    expect(() => assertUnprivileged(droppedPermanently(0))).toThrow(PrivilegeError);
    expect(() => assertUnprivileged(droppedPermanently(0))).toThrow(/running as root/);
  });

  it('throws for a real uid that is not root but an effective uid that is', () => {
    // A setuid binary, or a wrapper that set only the effective id. The process can
    // do everything root can do, and `getuid()` alone would not notice.
    const probe: PrivilegeProbe = {
      getuid: () => PANEL_UID,
      geteuid: () => 0,
      setuid: () => undefined,
    };
    expect(() => assertUnprivileged(probe)).toThrow(/euid 0/);
  });

  it('names the remediation rather than leaving an EACCES to be interpreted', () => {
    try {
      assertUnprivileged(droppedPermanently(0));
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('entrypoint.sh');
      expect(message).toContain(String(PANEL_UID));
      // The reason, not just the rule: a reader has to be able to tell why root is
      // refused rather than assume it is ceremony.
      expect(message).toContain('agent processes');
    }
  });
});

describe('a permanent drop passes', () => {
  it('reports the uid and that root is unreachable', () => {
    expect(assertUnprivileged(droppedPermanently())).toEqual({
      supported: true,
      uid: PANEL_UID,
      euid: PANEL_UID,
      rootReachable: false,
    });
  });

  it('passes for any unprivileged uid, not just 10001', () => {
    expect(assertUnprivileged(droppedPermanently(1000))).toMatchObject({ uid: 1000 });
  });
});

describe('a reversible drop is a fatal error, not a warning', () => {
  it('throws, and drops back before doing so', () => {
    const probe = reversibleDrop();
    expect(() => assertUnprivileged(probe)).toThrow(/can return to root/);
    // The check regained root to find out, then handed it straight back. Leaving the
    // process as root would be a worse outcome than the one it is reporting.
    expect(probe.calls).toEqual([0, PANEL_UID]);
    expect(probe.getuid!()).toBe(PANEL_UID);
  });

  it('says what the fix is: the saved set-user-ID has to be set too', () => {
    try {
      assertUnprivileged(reversibleDrop());
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('saved set-user-ID');
      expect(message).toContain('setpriv');
    }
  });

  it('still throws when it cannot even drop back', () => {
    let attempts = 0;
    const probe: PrivilegeProbe = {
      getuid: () => PANEL_UID,
      geteuid: () => PANEL_UID,
      setuid: (id: number) => {
        attempts += 1;
        // Root is reachable, but going back is not. The worst case, and it must not
        // end in a running server.
        if (id !== 0) throw new Error('EPERM');
      },
    };
    expect(() => assertUnprivileged(probe)).toThrow(/could not drop back/);
    expect(attempts).toBe(2);
  });
});

describe('a platform with no uid concept is not an error', () => {
  it('reports unsupported rather than throwing', () => {
    expect(assertUnprivileged({})).toEqual({ supported: false });
  });

  it('skips the setuid probe when the platform has no setuid', () => {
    expect(assertUnprivileged({ getuid: () => PANEL_UID, geteuid: () => PANEL_UID })).toEqual({
      supported: true,
      uid: PANEL_UID,
      euid: PANEL_UID,
      rootReachable: false,
    });
  });
});

describe('the real process, whatever it happens to be', () => {
  it('is unprivileged here, which is also the project rule', () => {
    // CLAUDE.md: development runs as the non-root Linux user, not root. If this ever
    // fails, the suite is being run as root and that is the finding.
    const result = assertUnprivileged();
    expect(result.supported).toBe(true);
    if (result.supported) {
      expect(result.uid).not.toBe(0);
      expect(result.rootReachable).toBe(false);
    }
  });
});
