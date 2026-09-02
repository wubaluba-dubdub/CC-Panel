import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (name: string): string => readFileSync(join(ROOT, name), 'utf-8');

/**
 * The same rule the other static scans in this suite use: prose about a policy is the
 * point of the policy, so only code counts. Without this, a comment explaining *why*
 * `gosu` was not chosen fails the assertion that `gosu` is not used.
 */
const codeOnly = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/**
 * M1.6 — the deployment artefacts, asserted from the repository.
 *
 * This file and `scripts/verify-image.sh` are deliberately two halves of one check,
 * split along the line of what each can actually prove. The script inspects a *built
 * image* and is the only thing that can tell you what really shipped; it needs a
 * Docker engine, so it is an `npm run verify:image` step rather than part of the
 * suite. This file inspects the *inputs*, needs nothing, and runs on every
 * `npm test` — so a change that would break the image is caught before anyone builds
 * one.
 *
 * The assertions worth reading are the ones that derive an expectation from another
 * file rather than repeating a literal: the entrypoint's directory list against
 * `ensureDataLayout` in `app.ts`, and the uid against `utils/privileges.ts`. Two
 * copies of the same list in two languages is exactly the shape that drifts.
 */

describe('entrypoint.sh', () => {
  const entrypoint = read('entrypoint.sh');
  const code = codeOnly(entrypoint);

  it('contains no CR bytes', () => {
    // The fault this whole line-endings exercise exists for. A CRLF shebang makes the
    // kernel look for an interpreter named `/bin/sh\r`, and the container dies with
    // `exec /entrypoint.sh: no such file or directory` — naming the file it just
    // found, and reading like a missing file rather than a formatting problem.
    expect(entrypoint).not.toContain('\r');
  });

  it('starts with a shebang and fails fast', () => {
    expect(entrypoint.startsWith('#!/bin/sh\n')).toBe(true);
    expect(entrypoint).toMatch(/^set -eu$/m);
  });

  it('execs, so the server becomes pid 1 and receives SIGTERM directly', () => {
    // Without `exec` there is a shell between the container runtime and node, and it
    // does not forward signals — so `docker stop` becomes `docker kill` after ten
    // seconds and the WAL is left for recovery on every deploy.
    expect(code).toMatch(/^\s*exec setpriv \\$/m);
    expect(code).toMatch(/^exec "\$@"$/m);
  });

  it('drops privileges in the one way that also sets the saved uid', () => {
    for (const flag of ['--reuid', '--regid', '--clear-groups', '--no-new-privs']) {
      expect(code, flag).toContain(flag);
    }
    // `su`, `sudo` and a downloaded `gosu` are all alternatives that were not chosen;
    // the first two also leave a parent process in the way of signals.
    expect(code).not.toMatch(/\bexec su\b/);
    expect(code).not.toContain('gosu');
  });

  it('never chowns recursively', () => {
    // /data grows to hold project checkouts. A recursive chown over those on every
    // boot is a startup that gets slower forever, and on a network-backed volume it is
    // an outage. Measured: the no-op pass is ~25 ms and does not move when 20 000
    // files are added to the volume; `chown -R` over the same volume is 170 ms and
    // scales with the file count.
    expect(code).not.toMatch(/chown\s+(-\w*[Rr]|--recursive)/);
    expect(code).toContain('stat -c');
  });

  it('names the exact remediation when it cannot fix the volume itself', () => {
    expect(entrypoint).toContain('RAILWAY_RUN_UID=0');
    expect(entrypoint).toContain('docs/DEPLOY.md');
    // And refuses rather than starting and failing on the first write.
    expect(entrypoint).toContain('Refusing to start rather than degrading.');
  });

  it('refuses to run without setpriv rather than serving as root', () => {
    expect(code).toMatch(/command -v setpriv/);
    expect(code).toMatch(/die "setpriv is not installed/);
  });

  it('prepares exactly the directories the server expects, and no fewer', () => {
    // Derived from app.ts rather than repeated. `ensureDataLayout` is the authority on
    // the layout; the entrypoint's job is to have made all of it writable first.
    const app = read('src/server/app.ts');
    const layout = /export function ensureDataLayout[\s\S]*?\n}/.exec(app);
    expect(layout, 'ensureDataLayout was renamed or removed').not.toBeNull();

    const expected = [
      ...layout![0].matchAll(/join\(dataDir,\s*([^)]*)\)/g),
    ].map((m) => m[1]!.split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).join('/'));
    expect(expected).toEqual(['home', 'config', 'global/claude-home', 'projects', 'logs']);

    for (const dir of expected) {
      expect(entrypoint, dir).toContain(`$DATA_DIR/${dir}`);
    }
    // The top level itself, and `global` on its own — the entrypoint lists the
    // intermediate directory explicitly because `mkdir -p` creates it with root's
    // ownership on the way to `global/claude-home`, and nothing else would fix it.
    expect(entrypoint).toMatch(/^\$DATA_DIR$/m);
    expect(entrypoint).toMatch(/^\$DATA_DIR\/global$/m);
  });

  it('resolves the data directory to the same place the server will open', () => {
    // Railway exposes the mount path; the server reads PANEL_DATA_DIR. If these two
    // disagree the entrypoint prepares one directory and the server opens another.
    expect(code).toContain('RAILWAY_VOLUME_MOUNT_PATH');
    expect(code).toMatch(/export PANEL_DATA_DIR="\$DATA_DIR"/);
  });

  it('uses the same uid the server asserts it is running as', () => {
    const privileges = read('src/server/utils/privileges.ts');
    const uid = /export const PANEL_UID = (\d+);/.exec(privileges);
    expect(uid, 'PANEL_UID was renamed or removed').not.toBeNull();
    expect(entrypoint).toContain(`PANEL_UID:-${uid![1]!}`);
  });
});

describe('Dockerfile', () => {
  const dockerfile = read('Dockerfile');

  it('uses the same base image in both stages', () => {
    // better-sqlite3 is compiled in the builder against that image's glibc, libstdc++
    // and Node ABI. A different runtime base loads the binary and fails at `require`
    // time, at container start, on a deployment that built cleanly.
    const bases = [...dockerfile.matchAll(/^FROM (\S+) AS (\S+)$/gm)].map((m) => [m[1]!, m[2]!]);
    expect(bases).toHaveLength(2);
    expect(bases[0]![0]).toBe(bases[1]![0]);
    expect(bases[0]![0]).toBe('node:22-bookworm-slim');
    expect(bases.map((b) => b[1])).toEqual(['builder', 'runtime']);
  });

  it('keeps the compiler in the builder and prunes dev dependencies', () => {
    const [builder, runtime] = dockerfile.split('FROM node:22-bookworm-slim AS runtime');
    const builderCode = codeOnly(builder!);
    const runtimeCode = codeOnly(runtime!);
    for (const tool of ['python3', 'make', 'g++']) {
      expect(builderCode, tool).toContain(tool);
      expect(runtimeCode, tool).not.toContain(tool);
    }
    expect(builderCode).toContain('npm prune --omit=dev');
  });

  it('installs what the panel needs today and nothing on account of later phases', () => {
    const runtime = dockerfile.split('AS runtime')[1]!;
    // ca-certificates: M1.7's outbound TLS. util-linux: setpriv, for the drop.
    expect(runtime).toContain('ca-certificates');
    expect(runtime).toContain('util-linux');
    // Comments stripped: the whole point of the block above the install is to *name*
    // the tools each later phase adds, so scanning the prose would forbid documenting
    // the decision.
    const installed = codeOnly(runtime);
    for (const later of ['git', 'tmux', 'ripgrep', 'jq', '@anthropic-ai/claude-code']) {
      expect(installed, later).not.toMatch(new RegExp(`\\b${later.replace(/[/@-]/g, '\\$&')}\\b`));
    }
    // And the comment that says which phase adds each one, so it is not rediscovered.
    expect(runtime).toContain('Phase 3');
    expect(runtime).toContain('Phase 5');
  });

  it('declares the environment the runtime depends on', () => {
    for (const pair of [
      'NODE_ENV=production',
      'PORT=8080',
      'PANEL_DATA_DIR=/data',
      'PANEL_IN_CONTAINER=1',
      'HOME=/data/home',
    ]) {
      expect(dockerfile, pair).toContain(pair);
    }
  });

  it('health-checks /healthz through PORT rather than a literal port', () => {
    const healthcheck = /^HEALTHCHECK[\s\S]*?\n(?=\n|#|[A-Z])/m.exec(dockerfile);
    expect(healthcheck, 'no HEALTHCHECK instruction').not.toBeNull();
    expect(healthcheck![0]).toContain('/healthz');
    // Hard-coding 8080 here would silently disable the check for anyone who overrode
    // PORT — the probe would hit a closed port and the container would restart-loop.
    expect(healthcheck![0]).toContain('process.env.PORT');
  });

  it('has no USER directive, because the entrypoint owns the drop', () => {
    // A `USER 10001` would run the container as 10001 from the start, which is exactly
    // the state in which it cannot prepare a root-owned volume mount.
    expect(dockerfile).not.toMatch(/^USER /m);
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/entrypoint\.sh"\]$/m);
    expect(dockerfile).toMatch(/^CMD \["node", "dist\/server\/index\.js"\]$/m);
  });

  it('copies the scripts the build itself runs', () => {
    // `npm run build` is tsc plus scripts/copy-assets.mjs. Without the COPY the build
    // stage fails outright — which is the good failure mode, but only because the
    // .dockerignore no longer excludes the directory.
    expect(dockerfile).toContain('COPY scripts ./scripts');
    expect(read('.dockerignore')).not.toMatch(/^scripts$/m);
  });
});

describe('.dockerignore', () => {
  const ignore = read('.dockerignore');
  const lines = ignore.split('\n').map((l) => l.trim());

  it('excludes every kind of local state and secret', () => {
    for (const pattern of ['.env', '.env.*', '.localdata', '.localdate', '*.db', 'data']) {
      expect(lines, pattern).toContain(pattern);
    }
    // The example file is the one .env* that must survive, since it is documentation.
    expect(lines).toContain('!.env.example');
  });

  it('excludes the git history, which is the largest and worst of them', () => {
    // Every earlier version of every file: a secret committed once and removed later
    // is still in there.
    expect(lines).toContain('.git');
  });

  it('excludes build output and the test suite', () => {
    for (const pattern of ['dist', 'node_modules', 'tests', 'coverage', 'tmp']) {
      expect(lines, pattern).toContain(pattern);
    }
  });
});

describe('.gitattributes', () => {
  const attributes = read('.gitattributes');

  it('pins LF for shell scripts, the Dockerfile and the entrypoint', () => {
    expect(attributes).toMatch(/^\*\.sh\s+text eol=lf$/m);
    expect(attributes).toMatch(/^Dockerfile\s+text eol=lf$/m);
    expect(attributes).toMatch(/^entrypoint\.sh\s+text eol=lf$/m);
  });

  it('defaults the whole tree to LF rather than to the platform', () => {
    expect(attributes).toMatch(/^\* text=auto eol=lf$/m);
  });

  it('says why, because the symptom names the wrong problem', () => {
    expect(attributes).toContain('no such file or directory');
  });
});

describe('railway.json', () => {
  const config = JSON.parse(read('railway.json')) as {
    build: { builder: string };
    deploy: { healthcheckPath: string; numReplicas: number; restartPolicyType: string };
  };

  it('builds from the Dockerfile rather than a detected buildpack', () => {
    expect(config.build.builder).toBe('DOCKERFILE');
  });

  it('points the healthcheck at /healthz', () => {
    // Railway polls this until it returns 200 and only then makes the deployment live.
    // A wrong path means every deploy waits out the timeout and then fails.
    expect(config.deploy.healthcheckPath).toBe('/healthz');
  });

  it('pins one replica, because two would open the same SQLite file', () => {
    // Not a scaling preference. `panel.db` is a single file on a single volume with
    // WAL; a second replica is a second writer, and Railway volumes attach to one
    // service instance anyway.
    expect(config.deploy.numReplicas).toBe(1);
  });
});
