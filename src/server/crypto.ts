import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { inspect } from 'node:util';

// ─── Key derivation ──────────────────────────────────────────────────────────

/**
 * The master key. Module-private on purpose: it is never used directly for
 * encryption, never exported, and never returned from any function here. Every
 * consumer gets a purpose-specific subkey instead, so a bug in one subsystem
 * cannot produce a ciphertext another subsystem will accept.
 */
let masterKey: Buffer | null = null;
const subkeyCache = new Map<string, Buffer>();

/**
 * HKDF salt. A constant is correct here: the master key is already 32 bytes of
 * CSPRNG output, so the salt's job (spreading low-entropy input material) is
 * moot, and a constant keeps derivation reproducible across restarts.
 */
const HKDF_SALT = Buffer.from('cc-panel/hkdf/v1', 'utf8');

const SUBKEY_LENGTH = 32;

/** Info labels. One per purpose — never reuse a label for a second purpose. */
export const KeyPurpose = {
  /** Encrypting secret columns at rest. */
  SecretColumn: 'cc-panel/v1/secret-column',
  /** HMAC key for the double-submit CSRF token. Signing, not encryption. */
  CsrfToken: 'cc-panel/v1/csrf-token',
  /**
   * HMAC key for the audit log's hash chain.
   *
   * Its own label, so the chain is not forgeable by anyone who learns any other
   * derived key, and — more to the point — so an attacker who has the database file
   * but not `PANEL_MASTER_KEY` cannot recompute a row's hash after editing it. A
   * bare SHA-256 chain would be recomputable by whoever can read the rows, which is
   * exactly the attacker the chain exists to catch.
   */
  AuditChain: 'cc-panel/v1/audit-chain',
} as const;

export class CryptoNotInitializedError extends Error {
  constructor() {
    super('crypto is not initialized — call initCrypto() first');
    this.name = 'CryptoNotInitializedError';
  }
}

export function initCrypto(masterKeyBase64: string): void {
  const key = Buffer.from(masterKeyBase64, 'base64');
  if (key.length < 32) {
    throw new Error(`PANEL_MASTER_KEY must be at least 32 bytes (got ${key.length})`);
  }
  masterKey = key;
  subkeyCache.clear();
}

/** Test/shutdown hook. Drops the key and every derived subkey. */
export function resetCrypto(): void {
  masterKey?.fill(0);
  masterKey = null;
  for (const subkey of subkeyCache.values()) subkey.fill(0);
  subkeyCache.clear();
}

export function isCryptoInitialized(): boolean {
  return masterKey !== null;
}

/**
 * Derives a 32-byte subkey for `info` via HKDF-SHA256. Deterministic, memoized,
 * and cheap after the first call.
 */
export function deriveSubkey(info: string): Buffer {
  if (masterKey === null) throw new CryptoNotInitializedError();
  const cached = subkeyCache.get(info);
  if (cached) return cached;

  const derived = Buffer.from(
    hkdfSync('sha256', masterKey, HKDF_SALT, Buffer.from(info, 'utf8'), SUBKEY_LENGTH),
  );
  subkeyCache.set(info, derived);
  return derived;
}

// ─── Encryption ──────────────────────────────────────────────────────────────

/**
 * The payload envelope versions this module knows.
 *
 * Both are the same bytes on the wire — `<version>.<nonce>.<ciphertext>.<tag>` — and
 * the version does not describe the *format*. It describes **which AAD the payload was
 * written under**, which is the one thing a reader cannot work out for itself and must
 * not guess at:
 *
 * - `v1` — `secrets:<rowId>:payload`, the row-id form M1.3 shipped. Binds a ciphertext
 *   to the row it was written into, so it cannot be moved between rows. It does *not*
 *   bind the row's logical identity: an attacker with write access to `panel.db` can
 *   rename a row's `scope`/`name` and the ciphertext still decrypts.
 * - `v2` — `secrets:<scope>:<name>`, and strictly stronger given `UNIQUE (scope, name)`
 *   in migration 006, because at most one row can hold a given pair. Applied to the
 *   Telegram credentials that difference is not theoretical: swap the `bot_token` and
 *   `chat_id` labels under `v1` and the panel puts the bot token into the `chat_id`
 *   query parameter of an outbound request. Telegram rejects it, and the token has
 *   still left the building.
 *
 * The version prefix exists precisely so this could be changed once without guessing,
 * and {@link decryptToBuffer} still rejects anything it does not know. **New callers
 * should pass `'v2'`;** the default stays `v1` so the two existing row-bound users
 * (`users.totp_secret_encrypted` and any secret written before migration 009) keep
 * their meaning without a per-call-site audit.
 */
export const PAYLOAD_VERSIONS = ['v1', 'v2'] as const;
export type PayloadVersion = (typeof PAYLOAD_VERSIONS)[number];

const PAYLOAD_VERSION: PayloadVersion = 'v1';
const NONCE_BYTES = 12; // 96-bit, the GCM-recommended size
const TAG_BYTES = 16; // 128-bit authentication tag
const ALGORITHM = 'aes-256-gcm';

/** Thrown for a payload this module cannot even parse, including a version it does not know. */
export class PayloadFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadFormatError';
  }
}

/**
 * Thrown when authentication fails. Deliberately says nothing about *why*: a
 * wrong AAD, a flipped ciphertext bit, and a wrong master key are
 * indistinguishable to the caller.
 */
export class DecryptionError extends Error {
  constructor() {
    super('decryption failed');
    this.name = 'DecryptionError';
  }
}

/**
 * Builds the additional authenticated data for a stored column.
 *
 * Binding the ciphertext to `<table>:<rowId>:<column>` means a payload lifted out
 * of one row, or out of one column, will not authenticate anywhere else — an
 * attacker with write access to the database cannot promote their own secret into
 * another row by copying bytes.
 */
export function columnAad(table: string, rowId: string | number, column: string): string {
  for (const [label, part] of [
    ['table', table],
    ['column', column],
  ] as const) {
    if (part.includes(':')) {
      throw new Error(`AAD ${label} must not contain ':' (got ${JSON.stringify(part)})`);
    }
    if (part.length === 0) throw new Error(`AAD ${label} must not be empty`);
  }
  return `${table}:${rowId}:${column}`;
}

/**
 * Encrypts `plaintext` under the secret-column subkey.
 *
 * Returns a versioned, self-describing string: `v1.<nonce>.<ciphertext>.<tag>`,
 * each part base64url. A fresh 96-bit nonce is drawn for every call, so the same
 * plaintext never produces the same payload twice.
 */
export function encrypt(
  plaintext: string | Buffer,
  aad: string,
  version: PayloadVersion = PAYLOAD_VERSION,
): string {
  const key = deriveSubkey(KeyPurpose.SecretColumn);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));

  const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    version,
    nonce.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

/** Decrypts a payload produced by {@link encrypt}, returning the raw bytes. */
export function decryptToBuffer(payload: string, aad: string): Buffer {
  const parts = payload.split('.');
  if (parts.length !== 4) {
    throw new PayloadFormatError(`malformed payload: expected 4 parts, got ${parts.length}`);
  }

  const [version, nonceB64, ciphertextB64, tagB64] = parts as [string, string, string, string];

  // Reject unknown versions outright rather than guessing at the layout.
  if (!isPayloadVersion(version)) {
    throw new PayloadFormatError(`unknown payload version: ${JSON.stringify(version)}`);
  }

  const nonce = Buffer.from(nonceB64, 'base64url');
  const ciphertext = Buffer.from(ciphertextB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');

  if (nonce.length !== NONCE_BYTES) {
    throw new PayloadFormatError(`bad nonce length: ${nonce.length}`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new PayloadFormatError(`bad auth tag length: ${tag.length}`);
  }

  const key = deriveSubkey(KeyPurpose.SecretColumn);
  const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM tag mismatch. Collapsed into one opaque error so a caller cannot
    // learn which of the inputs was wrong.
    throw new DecryptionError();
  }
}

function isPayloadVersion(value: string): value is PayloadVersion {
  return (PAYLOAD_VERSIONS as readonly string[]).includes(value);
}

/**
 * Which AAD scheme a stored payload was written under.
 *
 * Read *before* the AAD is built, because the version is what says how to build it.
 * Throws for anything this module does not recognise, so a caller cannot fall back to
 * a guess — the same stance as {@link decryptToBuffer}.
 */
export function payloadVersionOf(payload: string): PayloadVersion {
  const version = payload.split('.', 1)[0] ?? '';
  if (!isPayloadVersion(version)) {
    throw new PayloadFormatError(`unknown payload version: ${JSON.stringify(version)}`);
  }
  return version;
}

/** Decrypts a payload produced by {@link encrypt}, returning UTF-8 text. */
export function decrypt(payload: string, aad: string): string {
  return decryptToBuffer(payload, aad).toString('utf8');
}

// ─── Secrets in memory ───────────────────────────────────────────────────────

export const REDACTED = '[redacted]';

/**
 * Credential prefixes that are not themselves secret. Kept visible by
 * {@link mask} and by the logger redaction layer so a human can tell *which kind*
 * of credential they are looking at without seeing any of it.
 */
export const CREDENTIAL_PREFIXES = [
  'sk-ant-',
  'github_pat_',
  'ghp_',
  'gho_',
  'sk-',
] as const;

/**
 * Masks a secret for display: `sk-ant-…a1b2`.
 *
 * Never reveals more than the last four characters. A recognised credential
 * prefix is kept — it identifies the credential type without disclosing any of
 * the secret material — but only when enough characters remain after it that
 * keeping it does not push the total revealed past four. Values shorter than
 * eight characters get a fixed placeholder, because at that length the last four
 * characters would be half the secret.
 */
export function mask(value: string): string {
  if (value.length < 8) return REDACTED;

  const prefix = CREDENTIAL_PREFIXES.find((p) => value.startsWith(p)) ?? '';
  const keepPrefix = value.length - prefix.length >= 8 ? prefix : '';

  return `${keepPrefix}…${value.slice(-4)}`;
}

/**
 * A secret held in memory.
 *
 * The value is only reachable through {@link SecretString.reveal}, which makes
 * every disclosure an explicit, greppable act. Every implicit path a secret
 * normally escapes through — string interpolation, `String()`, `+`,
 * `JSON.stringify`, `console.log`, `util.inspect`, and pino's serializers, which
 * go through `toJSON` — is overridden to yield `[redacted]`.
 *
 * This is the primary defence. The logger redaction layer is the second one, and
 * it only recognises patterns, so it is not a substitute for this.
 */
export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The only way to get the value out. Call sites should be few and obvious. */
  reveal(): string {
    return this.#value;
  }

  /** Display form: `sk-ant-…a1b2`. Safe to log and to render. */
  mask(): string {
    return mask(this.#value);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /** Covers `` `${secret}` `` and `secret + ''`, which do not go via toString first. */
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  /** Covers console.log(secret) and util.inspect(secret), including nested. */
  [inspect.custom](): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return 'SecretString';
  }
}


