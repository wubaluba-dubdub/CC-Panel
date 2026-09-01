import type { Env } from '../env.js';

/**
 * The origin this panel is reached at, resolved from configuration once at boot.
 *
 * This is the single place the effective public origin is decided, and two
 * different controls read it:
 *
 * - `plugins/cookies.ts` decides from `secure` whether the session cookie carries
 *   the `__Secure-` name prefix and the `Secure` attribute.
 * - `plugins/origin-check.ts` compares an incoming `Origin` and `Host` against it.
 *
 * Both used to answer that question for themselves — the cookie by hard-coding
 * `secure: true`, the origin check by reading the request's own `Host` header. The
 * second was worse than useless: `Host` is attacker-supplied, so validating
 * `Origin` against it accepts any `Origin` an attacker also controls the `Host`
 * for. Deriving both from configuration, in one module, is what makes the two
 * consistent by construction rather than by comment.
 */
export interface PublicOrigin {
  /** `https://panel.example.com` — scheme and authority, never a trailing slash. */
  readonly origin: string;
  readonly protocol: 'http' | 'https';
  /** Authority as it appears in a `Host` or `Origin` header, port included when non-default. */
  readonly host: string;
  readonly hostname: string;
  /** True when the origin is https. The one input to the cookie profile. */
  readonly secure: boolean;
  /** True for `localhost`, `127.0.0.0/8` and `[::1]`. */
  readonly loopback: boolean;
  readonly source: 'PANEL_PUBLIC_URL' | 'RAILWAY_PUBLIC_DOMAIN' | 'development-fallback';
}

export class PublicOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicOriginError';
  }
}

/**
 * Loopback is the only place an http origin is tolerated, because it is the only
 * place a browser treats http as a potentially-trustworthy origin at all.
 *
 * `localhost` is matched by name because browsers special-case the name, not just
 * the address it resolves to.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (bare === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

function fromUrl(raw: string, source: PublicOrigin['source']): PublicOrigin {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PublicOriginError(`PANEL_PUBLIC_URL is not a valid absolute URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PublicOriginError(`PANEL_PUBLIC_URL must be http or https, got ${url.protocol}`);
  }
  // A path, query or fragment here is a configuration mistake with a silent
  // failure mode: the panel would compare against an origin that can never match
  // what a browser sends, since an Origin header carries no path.
  if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    throw new PublicOriginError(
      `PANEL_PUBLIC_URL must be an origin with no path, query or fragment: ${raw}`,
    );
  }

  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  return {
    origin: `${protocol}://${url.host}`,
    protocol,
    host: url.host,
    hostname: url.hostname,
    secure: protocol === 'https',
    loopback: isLoopbackHostname(url.hostname),
    source,
  };
}

/**
 * Resolves the public origin, or refuses to boot.
 *
 * Order: `PANEL_PUBLIC_URL`, then `RAILWAY_PUBLIC_DOMAIN` (which Railway injects
 * and which is always fronted by its TLS terminator, hence https), then — only
 * outside production — a loopback fallback.
 *
 * Three fatal conditions, all of which would otherwise degrade quietly:
 *
 * 1. Production with neither variable set. There is no safe guess, and guessing
 *    from the request would be the circular check this module exists to remove.
 * 2. Production with a non-https origin. The alternative is a silent downgrade of
 *    the session cookie on a deployment that believes it is protected.
 * 3. A non-loopback http origin anywhere. The `__Secure-` prefix cannot be used,
 *    and dropping it for a routable host means shipping a cookie a network
 *    attacker can both read and overwrite.
 */
export function resolvePublicOrigin(env: Env): PublicOrigin {
  const production = env.NODE_ENV === 'production';

  let resolved: PublicOrigin;
  if (env.PANEL_PUBLIC_URL !== undefined) {
    resolved = fromUrl(env.PANEL_PUBLIC_URL, 'PANEL_PUBLIC_URL');
  } else if (env.RAILWAY_PUBLIC_DOMAIN !== undefined) {
    resolved = fromUrl(`https://${env.RAILWAY_PUBLIC_DOMAIN}`, 'RAILWAY_PUBLIC_DOMAIN');
  } else if (production) {
    throw new PublicOriginError(
      'FATAL: PANEL_PUBLIC_URL is required when NODE_ENV=production. ' +
        'The public origin decides the session cookie prefix and the Origin/Host check, ' +
        'and it must not be inferred from a request header.',
    );
  } else {
    const authority = env.PORT === 0 ? 'localhost' : `localhost:${env.PORT}`;
    resolved = fromUrl(`http://${authority}`, 'development-fallback');
  }

  if (production && !resolved.secure) {
    throw new PublicOriginError(
      `FATAL: the public origin is ${resolved.origin}, which is not https, and NODE_ENV=production. ` +
        'Refusing to start rather than silently downgrading the session cookie. ' +
        'Set PANEL_PUBLIC_URL to the https origin the panel is served on.',
    );
  }

  if (!resolved.secure && !resolved.loopback) {
    throw new PublicOriginError(
      `FATAL: the public origin is ${resolved.origin} — plain http on a non-loopback host. ` +
        'The secure cookie name prefix is unusable there and dropping it would ship a session ' +
        'cookie any network attacker can read and overwrite. Serve the panel over https, ' +
        'or bind it to loopback for local development.',
    );
  }

  return resolved;
}
