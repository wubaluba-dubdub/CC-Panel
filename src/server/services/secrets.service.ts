import type { Database } from 'better-sqlite3';
import { getDb } from '../db.js';
import {
  SecretString,
  columnAad,
  decrypt,
  encrypt,
  payloadVersionOf,
  type PayloadVersion,
} from '../crypto.js';
import { type Clock, isoNow, systemClock } from '../utils/clock.js';

const TABLE = 'secrets';
/** The column name in the `v1` row-id AAD. Not a column any more, only an AAD part. */
const LEGACY_COLUMN = 'payload';

/**
 * The version every write produces.
 *
 * `v2` binds a payload to `(scope, name)` rather than to the row id — see
 * {@link PAYLOAD_VERSIONS} in `crypto.ts` for why that is strictly stronger here, and
 * why the Telegram credentials made it worth changing. Reads accept both, so a row
 * written before migration 009 keeps decrypting under the old scheme for as long as it
 * exists.
 */
const WRITE_VERSION: PayloadVersion = 'v2';

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
 * Each row's payload is bound to a `secrets:<scope>:<name>` AAD, so a payload copied
 * into another row — or a row relabelled under an attacker's control — will not
 * authenticate. Rows written before migration 009 carry the older
 * `secrets:<id>:payload` binding and are read under it; {@link upgradeLegacyPayloads}
 * rewrites them.
 */
export class SecretsRepository {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(opts: { db?: Database; clock?: Clock } = {}) {
    this.#db = opts.db ?? getDb();
    this.#clock = opts.clock ?? systemClock;
  }

  /**
   * The AAD for a row, chosen by the payload's own version.
   *
   * **Injectivity over `(scope, name)` is the whole requirement**, and it is enforced
   * for free: `columnAad` refuses a `column` containing `:`, and `name` is passed as
   * the column. So `('project:7', 'x')` → `secrets:project:7:x` while
   * `('project', '7:x')` is rejected outright, rather than colliding with it. A `scope`
   * may contain colons — project scopes are `project:<uuid>` — because with `name`
   * colon-free the last colon always separates the two. An AAD is only ever compared
   * byte-for-byte, never parsed, so injectivity is all that is asked of it.
   */
  #aadFor(row: Pick<SecretRow, 'id' | 'scope' | 'name' | 'payload'>): string {
    return payloadVersionOf(row.payload) === 'v1'
      ? columnAad(TABLE, row.id, LEGACY_COLUMN)
      : columnAad(TABLE, row.scope, row.name);
  }

  /** The AAD a new `v2` write is bound to. */
  #writeAad(scope: string, name: string): string {
    return columnAad(TABLE, scope, name);
  }

  #findRow(scope: string, name: string): SecretRow | undefined {
    return this.#db
      .prepare('SELECT * FROM secrets WHERE scope = ? AND name = ?')
      .get(scope, name) as SecretRow | undefined;
  }

  /**
   * Creates or replaces a secret, returning its metadata.
   *
   * One statement per branch now, rather than M1.3's insert-empty-then-update dance:
   * that existed only because the `v1` AAD needed the row id to exist before there was
   * anything to encrypt, and `v2` is bound to `(scope, name)`, which the caller already
   * has. No row ever holds an empty payload, not even inside a transaction.
   *
   * Both timestamps come from the injected clock rather than SQLite's
   * `datetime('now')`. That default writes `YYYY-MM-DD HH:MM:SS` with no zone marker,
   * which a browser reads as *local* time — so these two columns, served raw, were the
   * one place in the panel whose times were wrong, by exactly this operator's +03:30.
   */
  set(scope: string, name: string, value: string | SecretString): SecretMetadata {
    const plaintext = value instanceof SecretString ? value.reveal() : value;
    const payload = encrypt(plaintext, this.#writeAad(scope, name), WRITE_VERSION);
    const now = isoNow(this.#clock);

    const write = this.#db.transaction((): SecretMetadata => {
      const existing = this.#findRow(scope, name);
      const id =
        existing === undefined
          ? Number(
              this.#db
                .prepare(
                  `INSERT INTO secrets (scope, name, payload, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?)`,
                )
                .run(scope, name, payload, now, now).lastInsertRowid,
            )
          : (this.#db
              .prepare('UPDATE secrets SET payload = ?, updated_at = ? WHERE id = ?')
              .run(payload, now, existing.id),
            existing.id);

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
    return new SecretString(decrypt(row.payload, this.#aadFor(row)));
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

  /**
   * Rewrites every `v1` row under the `v2` `(scope, name)` AAD. Called once at boot.
   *
   * In code rather than in migration 009, because a migration is SQL and re-encryption
   * needs the master key. It is also why this cannot be an *assertion* that no `v1` row
   * exists: on an install where the operator has already stored a secret, a migration
   * that aborted on one would be a panel that refuses to boot and cannot be talked out
   * of it.
   *
   * Idempotent, and a no-op on every install that has never written a secret. The
   * plaintext is unchanged, so `updated_at` deliberately is too — the secret did not
   * change, only the bytes it is stored as. A row that will not decrypt is left exactly
   * where it is and the error propagates: that is a wrong master key or a tamper, and
   * quietly skipping it would turn either into "nothing happened".
   *
   * **One consequence to know about before rolling a deployment back:** a `v2` payload
   * is unreadable to a build that predates this migration, which rejects the version
   * rather than guessing. Restoring a snapshot taken before the upgrade is the way out.
   */
  upgradeLegacyPayloads(): { upgraded: number } {
    const rows = this.#db.prepare('SELECT * FROM secrets').all() as SecretRow[];
    const legacy = rows.filter((row) => payloadVersionOf(row.payload) === 'v1');
    if (legacy.length === 0) return { upgraded: 0 };

    const rewrite = this.#db.prepare('UPDATE secrets SET payload = ? WHERE id = ?');
    const txn = this.#db.transaction((): void => {
      for (const row of legacy) {
        const plaintext = decrypt(row.payload, columnAad(TABLE, row.id, LEGACY_COLUMN));
        rewrite.run(encrypt(plaintext, this.#writeAad(row.scope, row.name), WRITE_VERSION), row.id);
      }
    });
    txn();

    return { upgraded: legacy.length };
  }
}
