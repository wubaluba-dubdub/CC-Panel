import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/server/env.js';
import {
  LOOPBACK_HOST,
  WILDCARD_HOST,
  detectContainer,
  listenHostFor,
  resolveListenHost,
} from '../../src/server/utils/listen-host.js';

/**
 * M1.6 part 2.1 — which address the server binds.
 *
 * The value was `0.0.0.0`, hard-coded, and it was wrong in both directions at once.
 * In a container it has to be the wildcard, because Railway's edge reaches the
 * service over the container network and a process on `127.0.0.1` is unreachable
 * from it while its own logs say `Server listening` — the worst shape a deployment
 * failure can take. Outside a container the same value quietly exposes a development
 * server, with no TLS and a `Secure`-less session cookie, to the whole LAN.
 *
 * Both defaults are asserted here, which is the point: neither is a comment.
 */

const BASE_ENV: Env = {
  PANEL_MASTER_KEY: Buffer.from('a'.repeat(32)).toString('base64'),
  PANEL_TRUST_PROXY: true,
  PANEL_DATA_DIR: '/tmp/panel-listen-host-unused',
  PORT: 3000,
  NODE_ENV: 'development',
};

/** No `/.dockerenv`, so only `PANEL_IN_CONTAINER` can make `detectContainer` true. */
const noDockerEnv = (): boolean => false;

describe('the container default is the wildcard', () => {
  it('binds 0.0.0.0 when the image says it is a container', () => {
    const resolved = resolveListenHost({ production: false, inContainer: true });
    expect(resolved.host).toBe(WILDCARD_HOST);
    expect(resolved.source).toBe('container-default');
  });

  it('binds 0.0.0.0 in production even outside a container', () => {
    // A bare VM or a systemd unit. Something in front of the process still has to
    // reach it, and it is not on this machine.
    const resolved = resolveListenHost({ production: true, inContainer: false });
    expect(resolved.host).toBe(WILDCARD_HOST);
    expect(resolved.source).toBe('production-default');
  });

  it('reads it off the env the Dockerfile actually sets', () => {
    const env: Env = { ...BASE_ENV, PANEL_IN_CONTAINER: '1' };
    expect(listenHostFor(env, noDockerEnv)).toEqual({
      host: WILDCARD_HOST,
      source: 'container-default',
    });
  });

  it('falls back to /.dockerenv for an image that does not set the variable', () => {
    const seen: string[] = [];
    const resolved = listenHostFor(BASE_ENV, (path) => {
      seen.push(path);
      return path === '/.dockerenv';
    });
    expect(resolved.host).toBe(WILDCARD_HOST);
    expect(seen).toEqual(['/.dockerenv']);
  });
});

describe('the local-development default is loopback', () => {
  it('binds 127.0.0.1 with no container marker and no production flag', () => {
    const resolved = resolveListenHost({ production: false, inContainer: false });
    expect(resolved.host).toBe(LOOPBACK_HOST);
    expect(resolved.source).toBe('development-default');
  });

  it('is what `npm run dev` resolves to on this machine', () => {
    expect(listenHostFor(BASE_ENV, noDockerEnv)).toEqual({
      host: LOOPBACK_HOST,
      source: 'development-default',
    });
  });

  it('does not treat a non-"1" PANEL_IN_CONTAINER as a container', () => {
    // The Dockerfile sets exactly `1`. Anything else is a stray value, and guessing
    // at it is how a development server ends up on the wildcard by accident.
    for (const value of ['0', 'false', '', 'yes', 'true']) {
      const env: Env = { ...BASE_ENV, PANEL_IN_CONTAINER: value };
      expect(listenHostFor(env, noDockerEnv).host, JSON.stringify(value)).toBe(LOOPBACK_HOST);
    }
    expect(detectContainer({ ...BASE_ENV, PANEL_IN_CONTAINER: '1' }, noDockerEnv)).toBe(true);
  });
});

describe('an explicit PANEL_LISTEN_HOST always wins', () => {
  it('overrides both defaults', () => {
    expect(
      resolveListenHost({ explicit: '10.0.0.5', production: true, inContainer: true }),
    ).toEqual({ host: '10.0.0.5', source: 'PANEL_LISTEN_HOST' });
    expect(
      resolveListenHost({ explicit: LOOPBACK_HOST, production: true, inContainer: true }),
    ).toEqual({ host: LOOPBACK_HOST, source: 'PANEL_LISTEN_HOST' });
    expect(
      resolveListenHost({ explicit: WILDCARD_HOST, production: false, inContainer: false }),
    ).toEqual({ host: WILDCARD_HOST, source: 'PANEL_LISTEN_HOST' });
  });

  it('ignores a value that is only whitespace, rather than binding to it', () => {
    // `PANEL_LISTEN_HOST=` in a Railway variable list arrives as an empty string.
    // Passing that to `listen()` is an error at best and a wildcard at worst.
    for (const blank of ['', '   ', '\t']) {
      expect(
        resolveListenHost({ explicit: blank, production: false, inContainer: true }).source,
        JSON.stringify(blank),
      ).toBe('container-default');
    }
  });

  it('trims a value the operator pasted with surrounding space', () => {
    expect(resolveListenHost({ explicit: '  ::  ', production: false, inContainer: false })).toEqual(
      { host: '::', source: 'PANEL_LISTEN_HOST' },
    );
  });
});
