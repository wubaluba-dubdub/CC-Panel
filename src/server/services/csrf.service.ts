import { createHmac } from 'node:crypto';
import { KeyPurpose, deriveSubkey } from '../crypto.js';

/** The header a client must echo the cookie value in. */
export const CSRF_HEADER = 'x-csrf-token';

/**
 * The CSRF token for one session, at one point in that session's life.
 *
 * Derived rather than random, and that is the whole point. A bare random value
 * stored in a cookie and compared against a header proves only that whoever set
 * the cookie also set the header — which an attacker who can write a cookie for
 * this host (a sibling subdomain, an XSS elsewhere on the eTLD+1, a MITM on any
 * http origin sharing the domain) can do. This token cannot be produced without
 * the HKDF subkey, and it is bound to:
 *
 * - the session **row id**, so a token minted for one session is rejected on
 *   another; and
 * - the SHA-256 hash of that session's **current token**, so the CSRF token dies
 *   whenever the session token rotates — the second factor being accepted, the
 *   pre→full promotion, a password change — with no rotation bookkeeping of its
 *   own to forget. There is nothing to store: the expected value is recomputed
 *   from the session cookie the client just presented.
 *
 * The key is an HKDF subkey under its own `info` label, so it is not the key any
 * secret column is encrypted under. HMAC-SHA256, truncated to nothing: the full
 * 256-bit digest, base64url.
 */
export function csrfTokenFor(sessionId: number, sessionTokenHash: string): string {
  return createHmac('sha256', deriveSubkey(KeyPurpose.CsrfToken))
    .update(`${sessionId}:${sessionTokenHash}`, 'utf8')
    .digest('base64url');
}
