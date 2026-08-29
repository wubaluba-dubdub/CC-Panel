import type { Database } from 'better-sqlite3';
import { getDb } from '../db.js';
import { SecretString, columnAad, decrypt, encrypt } from '../crypto.js';

const TABLE = 'secrets';
const COLUMN = 'payload';

/** A secret's metadata. Never carries the value — see {@link SecretsRepository.get}. */
export interface SecretMetadata {
  id: number;
  scope: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface SecretRow {
  id: number;
  scope: string;
  name: string;
  payload: string;
  created_at: string;
  updated_at: string;
}

export class SecretNotFoundError extends Error {
  constructor(scope: string, name: string) {
    super(`no secret ${JSON.stringify(name)} in scope ${JSON.stringify(scope)}`);
    this.name = 'SecretNotFoundError';
  }
}

function toMetadata(row: SecretRow): SecretMetadata {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Storage for encrypted secrets.
 *
 * Reads return {@link SecretString}, never a raw string, so a value cannot reach a
 * log line or a response body by being passed along inattentively. Callers that
 * genuinely need the plaintext have to say `.reveal()`.
 *
 * Each row's payload is bound to its own `secrets:<id>:payload` AAD, so a payload
 * copied into a different row will not authenticate.
 */
export class SecretsRepository {
  readonly #db: Database;

  constructor(db: Database = getDb()) {
    this.#db = db;
  }

  #aad(id: number): string {
    return columnAad(TABLE, id, COLUMN);
  }

  #findRow(scope: string, name: string): SecretRow | undefined {
    return this.#db
      .prepare('SELECT * FROM secrets WHERE scope = ? AND name = ?')
      .get(scope, name) as SecretRow | undefined;
  }

  /**
   * Creates or replaces a secret, returning its metadata.
   *
   * A new row is inserted with an empty payload purely to allocate its id, then
   * updated with the real ciphertext in the same transaction — the AAD binds to
   * the row id, so the id has to exist before there is anything to encrypt. The
   * empty payload is never visible outside the transaction.
   */
  set(scope: string, name: string, value: string | SecretString): SecretMetadata {
    const plaintext = value instanceof SecretString ? value.reveal() : value;

    const write = this.#db.transaction((): SecretMetadata => {
      const existing = this.#findRow(scope, name);

      const id =
        existing?.id ??
        Number(
          this.#db
            .prepare('INSERT INTO secrets (scope, name, payload) VALUES (?, ?, ?)')
            .run(scope, name, '').lastInsertRowid,
        );

      this.#db
        .prepare("UPDATE secrets SET payload = ?, updated_at = datetime('now') WHERE id = ?")
        .run(encrypt(plaintext, this.#aad(id)), id);

      const row = this.#db.prepare('SELECT * FROM secrets WHERE id = ?').get(id) as SecretRow;
      return toMetadata(row);
    });

    return write();
  }

  /**
   * The decrypted secret, or `null` when there is no such row.
   *
   * A row that exists but will not decrypt throws instead of returning `null`:
   * that means a wrong master key or a tampered database, and silently reporting
   * it as "absent" would invite the caller to overwrite it.
   */
  get(scope: string, name: string): SecretString | null {
    const row = this.#findRow(scope, name);
    if (!row) return null;
    return new SecretString(decrypt(row.payload, this.#aad(row.id)));
  }

  /** Like {@link get}, but throws {@link SecretNotFoundError} instead of returning null. */
  require(scope: string, name: string): SecretString {
    const secret = this.get(scope, name);
    if (!secret) throw new SecretNotFoundError(scope, name);
    return secret;
  }

  /** Metadata only. Safe to serialise straight into a response. */
  list(scope?: string): SecretMetadata[] {
    const rows = (
      scope === undefined
        ? this.#db.prepare('SELECT * FROM secrets ORDER BY scope, name').all()
        : this.#db.prepare('SELECT * FROM secrets WHERE scope = ? ORDER BY name').all(scope)
    ) as SecretRow[];
    return rows.map(toMetadata);
  }

  has(scope: string, name: string): boolean {
    return this.#findRow(scope, name) !== undefined;
  }

  /** Returns true when a row was removed. */
  delete(scope: string, name: string): boolean {
    const result = this.#db
      .prepare('DELETE FROM secrets WHERE scope = ? AND name = ?')
      .run(scope, name);
    return result.changes > 0;
  }
}
