import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { closeDb, getDb, initDb, migrationFiles } from '../../src/server/db.js';
import {
  DecryptionError,
  SecretString,
  columnAad,
  decrypt,
  encrypt,
  initCrypto,
  resetCrypto,
} from '../../src/server/crypto.js';
import {
  SecretNotFoundError,
  SecretsRepository,
} from '../../src/server/services/secrets.service.js';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

let dataDir: string;
let repo: SecretsRepository;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'panel-secrets-'));
  initDb(join(dataDir, 'panel.db'));
  resetCrypto();
  initCrypto(KEY_A);
  repo = new SecretsRepository();
});

afterEach(() => {
  closeDb();
  resetCrypto();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('SecretsRepository', () => {
  it('round-trips a secret and returns a SecretString, not a string', () => {
    repo.set('global', 'anthropic_auth_token', 'sk-ant-api03-value-a1b2');

    const secret = repo.get('global', 'anthropic_auth_token');

    expect(secret).toBeInstanceOf(SecretString);
    expect(secret!.reveal()).toBe('sk-ant-api03-value-a1b2');
    expect(`${secret}`).toBe('[redacted]');
  });

  it('accepts a SecretString as input', () => {
    repo.set('global', 'token', new SecretString('wrapped-value'));
    expect(repo.get('global', 'token')!.reveal()).toBe('wrapped-value');
  });

  it('returns null for a secret that does not exist', () => {
    expect(repo.get('global', 'missing')).toBeNull();
    expect(repo.has('global', 'missing')).toBe(false);
  });

  it('throws from require() for a secret that does not exist', () => {
    expect(() => repo.require('global', 'missing')).toThrow(SecretNotFoundError);
  });

  it('stores only ciphertext — the plaintext is never in the row', () => {
    const plaintext = 'sk-ant-api03-never-in-the-clear';
    repo.set('global', 'token', plaintext);

    const row = getDb().prepare('SELECT * FROM secrets WHERE name = ?').get('token') as {
      payload: string;
    };

    expect(row.payload).not.toContain(plaintext);
    // `v2` since migration 009: the version says which AAD the payload is bound to.
    expect(row.payload).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('overwrites in place, keeping the row id', () => {
    const first = repo.set('global', 'token', 'first-value');
    const second = repo.set('global', 'token', 'second-value');

    expect(second.id).toBe(first.id);
    expect(repo.get('global', 'token')!.reveal()).toBe('second-value');
    expect(repo.list('global')).toHaveLength(1);
  });

  it('never leaves an empty payload behind when a write fails', () => {
    // set() inserts a placeholder row to allocate the id before it has anything
    // to encrypt. If that transaction did not roll back, a half-written secret
    // would survive.
    resetCrypto();
    expect(() => repo.set('global', 'token', 'value')).toThrow();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 0 });
  });

  it('scopes secrets independently', () => {
    repo.set('global', 'token', 'global-value');
    repo.set('project:1', 'token', 'project-value');

    expect(repo.get('global', 'token')!.reveal()).toBe('global-value');
    expect(repo.get('project:1', 'token')!.reveal()).toBe('project-value');
    expect(repo.list()).toHaveLength(2);
    expect(repo.list('project:1')).toHaveLength(1);
  });

  it('lists metadata without any value', () => {
    repo.set('global', 'token', 'sk-ant-api03-value-a1b2');

    const [entry] = repo.list('global');

    expect(entry).toMatchObject({ scope: 'global', name: 'token' });
    expect(JSON.stringify(repo.list())).not.toContain('sk-ant');
    expect(Object.keys(entry!).sort()).toEqual([
      'createdAt',
      'id',
      'name',
      'scope',
      'updatedAt',
    ]);
  });

  it('deletes and reports whether anything was removed', () => {
    repo.set('global', 'token', 'value');

    expect(repo.delete('global', 'token')).toBe(true);
    expect(repo.delete('global', 'token')).toBe(false);
    expect(repo.get('global', 'token')).toBeNull();
  });

  it('binds a payload to its own row — it cannot be moved between rows', () => {
    const a = repo.set('global', 'token_a', 'value-a');
    repo.set('global', 'token_b', 'value-b');

    const payloadA = (
      getDb().prepare('SELECT payload FROM secrets WHERE id = ?').get(a.id) as { payload: string }
    ).payload;

    // Transplant A's ciphertext into B's row, as an attacker with DB write
    // access would.
    getDb().prepare('UPDATE secrets SET payload = ? WHERE name = ?').run(payloadA, 'token_b');

    expect(() => repo.get('global', 'token_b')).toThrow(DecryptionError);
    // A itself still decrypts.
    expect(repo.get('global', 'token_a')!.reveal()).toBe('value-a');
  });

  it('binds a payload to its own column — it cannot be moved between columns', () => {
    const meta = repo.set('global', 'token', 'value');
    const forged = encrypt('attacker value', columnAad('secrets', meta.id, 'some_other_column'));

    getDb().prepare('UPDATE secrets SET payload = ? WHERE id = ?').run(forged, meta.id);

    expect(() => repo.get('global', 'token')).toThrow(DecryptionError);
  });

  it('throws rather than reporting a secret as absent under a different master key', () => {
    repo.set('global', 'token', 'value');

    resetCrypto();
    initCrypto(KEY_B);

    // Returning null here would invite the caller to overwrite a secret that is
    // still perfectly good, just unreadable with the wrong key.
    expect(() => new SecretsRepository().get('global', 'token')).toThrow(DecryptionError);
    expect(new SecretsRepository().has('global', 'token')).toBe(true);
  });

  it('binds the payload to (scope, name), matching the documented AAD', () => {
    repo.set('telegram', 'bot_token', 'value');

    // Proven by decrypting with the AAD spelled out by hand, rather than by asking the
    // repository to agree with itself. This is the pair PLAN.md fixes for the Telegram
    // credentials, and it is the reason the scheme changed: under the row-id AAD an
    // attacker with write access to panel.db could swap the `bot_token` and `chat_id`
    // labels and the panel would put the token in a `chat_id` query parameter.
    expect(decrypt(payloadOf('bot_token'), 'secrets:telegram:bot_token')).toBe('value');
  });

  it('rejects a name containing a colon, so the AAD stays injective', () => {
    // Without this rule `('project:7', 'x')` and `('project', '7:x')` would produce the
    // same AAD — a payload written for one readable as the other. `columnAad` refuses a
    // colon in the column, and `name` is the column, so the collision is impossible
    // rather than merely unlikely. A scope may contain colons: project scopes are
    // `project:<uuid>`, and with a colon-free name the last colon always separates them.
    expect(() => repo.set('project', '7:x', 'value')).toThrow(/must not contain/);
    expect(() => repo.set('project:7', 'x', 'value')).not.toThrow();
    expect(repo.get('project:7', 'x')!.reveal()).toBe('value');
  });

  it('still reads a v1 row written under the old row-id AAD', () => {
    // The row M1.3 would have written: `v1` payload, `secrets:<id>:payload` AAD.
    const meta = repo.set('global', 'legacy', 'placeholder');
    getDb()
      .prepare('UPDATE secrets SET payload = ? WHERE id = ?')
      .run(encrypt('legacy-value', columnAad('secrets', meta.id, 'payload'), 'v1'), meta.id);

    expect(repo.get('global', 'legacy')!.reveal()).toBe('legacy-value');
  });

  it('upgrades a v1 row to v2 in place, and is a no-op the second time', () => {
    const meta = repo.set('global', 'legacy', 'placeholder');
    getDb()
      .prepare('UPDATE secrets SET payload = ? WHERE id = ?')
      .run(encrypt('legacy-value', columnAad('secrets', meta.id, 'payload'), 'v1'), meta.id);

    expect(repo.upgradeLegacyPayloads()).toEqual({ upgraded: 1 });
    expect(payloadOf('legacy').startsWith('v2.')).toBe(true);
    // The value is untouched, and it is now bound to the pair.
    expect(repo.get('global', 'legacy')!.reveal()).toBe('legacy-value');
    expect(decrypt(payloadOf('legacy'), 'secrets:global:legacy')).toBe('legacy-value');
    // Idempotent: every boot after the first has nothing to do.
    expect(repo.upgradeLegacyPayloads()).toEqual({ upgraded: 0 });
  });

  it('writes both timestamps as ISO-8601 with an explicit Z', () => {
    // `datetime('now')` writes `YYYY-MM-DD HH:MM:SS`, which a browser reads as *local*
    // time — so these two columns, served raw, were the one place in the panel whose
    // times were wrong, by exactly this operator's +03:30. A Jalali calendar would have
    // hidden it rather than revealed it.
    const meta = repo.set('global', 'token', 'value');
    expect(meta.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(meta.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

/** One row's stored payload, by name. */
function payloadOf(name: string): string {
  return (
    getDb().prepare('SELECT payload FROM secrets WHERE name = ?').get(name) as { payload: string }
  ).payload;
}

describe('migration 006', () => {
  it('leaves the secrets table with a single versioned payload column', () => {
    const columns = (
      getDb().prepare('PRAGMA table_info(secrets)').all() as { name: string }[]
    ).map((c) => c.name);

    expect(columns).toEqual(['id', 'scope', 'name', 'payload', 'created_at', 'updated_at']);
    expect(columns).not.toContain('ciphertext');
    expect(columns).not.toContain('nonce');
  });

  it('records itself as applied', () => {
    const applied = getDb()
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as { version: number }[];

    expect(applied.map((r) => r.version)).toEqual(migrationFiles().map((m) => m.version));
  });
});
