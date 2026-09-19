import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeDb, getDb, initDb } from '../../src/server/db.js';
import { columnAad, decrypt, encrypt, initCrypto, resetCrypto, segmentedAad } from '../../src/server/crypto.js';
import { SecretsRepository } from '../../src/server/services/secrets.service.js';
import { BOT_TOKEN, CHAT_ID, TELEGRAM_SCOPE } from '../../src/server/services/telegram-config.js';
import {
  InvalidProjectSecretScopeError, PROJECT_API_KEY_NAME, PROJECT_HOOK_TOKEN_NAME,
  PROJECT_UUID_PATTERN, parseProjectSecretScope, projectApiKeyAad,
  projectHookTokenAad, projectSecretScope,
} from '../../src/server/utils/project-secret-scope.js';

/** The RFC 4122 example uuid: unmistakably synthetic, and stable for the literal pins. */
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_UUID = '00112233-4455-6677-8899-aabbccddeeff';
const SLUG = 'my-project';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'panel-project-scope-'));
  initDb(join(dataDir, 'panel.db'));
  resetCrypto();
  initCrypto(randomBytes(32).toString('base64'));
});

afterEach(() => {
  closeDb();
  resetCrypto();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Telegram AAD — the historical bytes, pinned as literals', () => {
  it('builds exactly secrets:telegram:bot_token and secrets:telegram:chat_id', () => {
    expect(Buffer.from(columnAad('secrets', TELEGRAM_SCOPE, BOT_TOKEN))).toEqual(
      Buffer.from('secrets:telegram:bot_token'),
    );
    expect(Buffer.from(columnAad('secrets', TELEGRAM_SCOPE, CHAT_ID))).toEqual(
      Buffer.from('secrets:telegram:chat_id'),
    );
  });

  it('decrypts a payload written under the pre-M2.2A literal AAD', () => {
    // Built through the literal string alone — encrypt() plus raw SQL — so the
    // production read path must reproduce those exact bytes to return the value.
    const payload = encrypt('synthetic-telegram-token', 'secrets:telegram:bot_token', 'v2');
    getDb()
      .prepare('INSERT INTO secrets (scope, name, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(TELEGRAM_SCOPE, BOT_TOKEN, payload, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    expect(new SecretsRepository().get(TELEGRAM_SCOPE, BOT_TOKEN)!.reveal()).toBe(
      'synthetic-telegram-token',
    );
  });
});

describe('segmentedAad', () => {
  it('matches columnAad byte-for-byte at three segments and joins any count beyond', () => {
    expect(segmentedAad('secrets', '42', 'payload')).toBe(columnAad('secrets', 42, 'payload'));
    expect(segmentedAad('secrets', 'telegram', BOT_TOKEN)).toBe('secrets:telegram:bot_token');
    expect(segmentedAad('a', 'b', 'c', 'd')).toBe('a:b:c:d');
  });

  it('rejects a colon in every segment, empty and lone segments — and columnAad keeps its own guard', () => {
    // The first attempt is what a naive three-segment hook-token build would
    // do: the scope's colon riding inside the unchecked rowId position.
    const attempts: (() => string)[] = [
      () => segmentedAad('secrets', `project:${UUID}`, PROJECT_HOOK_TOKEN_NAME),
      () => segmentedAad('secrets', 'project', `${UUID}:extra`),
      () => segmentedAad('sec:rets', '1', 'payload'),
      () => segmentedAad('secrets', '1', 'pay:load'),
      () => segmentedAad('secrets', '', 'payload'),
      () => segmentedAad('only-one-segment'),
    ];
    for (const attempt of attempts) expect(attempt).toThrow(/must not|needs at least two/);
    // columnAad still rejects colons in table and column — the two it guards.
    expect(() => columnAad('sec:rets', 1, 'payload')).toThrow(/must not contain/);
    expect(() => columnAad('secrets', 1, 'pay:load')).toThrow(/must not contain/);
  });
});

describe('projectSecretScope / parseProjectSecretScope', () => {
  it('constructs project:<uuid> and round-trips exactly', () => {
    expect(projectSecretScope(UUID)).toBe(`project:${UUID}`);
    expect(parseProjectSecretScope(`project:${UUID}`)).toBe(UUID);
    const generated = randomUUID();
    expect(parseProjectSecretScope(projectSecretScope(generated))).toBe(generated);
    expect(generated).toMatch(PROJECT_UUID_PATTERN);
  });

  it('rejects malformed uuids at the construction site', () => {
    // Uppercase is a second spelling of the id, not the same id: identity is
    // byte-exact here, so it is rejected rather than folded.
    const badUuids = [
      'not-a-uuid', SLUG, '',
      '123E4567-E89B-42D3-A456-426614174000',
      `{${UUID}}`,
      `urn:uuid:${UUID}`,
      UUID.replace(/-/g, ''),
      ` ${UUID}`,
      `${UUID}\n`,
      `dir/${UUID}`,
    ];
    for (const bad of badUuids) {
      expect(() => projectSecretScope(bad)).toThrow(InvalidProjectSecretScopeError);
      expect(() => parseProjectSecretScope(`project:${bad}`)).toThrow(InvalidProjectSecretScopeError);
    }
  });

  it('rejects anything beyond one prefix and one uuid', () => {
    const badScopes = [
      `project:${UUID}:extra`, `project:${UUID}:`, `project::${UUID}`,
      ` project:${UUID}`, `project:${UUID} `, 'project', UUID,
      `global:${UUID}`, `project/${UUID}`, `project:${SLUG}`, null,
    ];
    for (const bad of badScopes) {
      expect(() => parseProjectSecretScope(bad as string)).toThrow(InvalidProjectSecretScopeError);
    }
  });
});

describe('project AAD', () => {
  it('pins both shapes as literals, deterministic per uuid', () => {
    expect(projectApiKeyAad(UUID)).toBe(`projects:${UUID}:api_key`);
    expect(projectHookTokenAad(UUID)).toBe(`secrets:project:${UUID}:hook_token`);
    // The names are half of the AAD; a typo there is a DecryptionError, not a
    // missing secret — so they are pinned as literals too.
    expect(PROJECT_API_KEY_NAME).toBe('api_key');
    expect(PROJECT_HOOK_TOKEN_NAME).toBe('hook_token');
    expect(projectApiKeyAad(UUID)).toBe(projectApiKeyAad(UUID));
    expect(projectHookTokenAad(UUID)).toBe(projectHookTokenAad(UUID));
    // Unambiguous: four colon-free segments, the scope's colon is the separator.
    expect(projectHookTokenAad(UUID).split(':')).toEqual(['secrets', 'project', UUID, 'hook_token']);
  });

  it('depends on the uuid, never on a slug, and guards the AAD construction site', () => {
    // A rename rewrites projects.slug and nothing else, so the scope and both
    // AADs are byte-identical across it, and never contain the slug at all.
    const before = [projectSecretScope(UUID), projectApiKeyAad(UUID), projectHookTokenAad(UUID)];
    const after = [projectSecretScope(UUID), projectApiKeyAad(UUID), projectHookTokenAad(UUID)];
    expect(after).toEqual(before);
    for (const value of before) expect(value).not.toContain(SLUG);
    expect(projectApiKeyAad(OTHER_UUID)).not.toBe(projectApiKeyAad(UUID));
    expect(projectHookTokenAad(OTHER_UUID)).not.toBe(projectHookTokenAad(UUID));
    // A malformed uuid — and the scope string, which is not a uuid; the two are
    // not interchangeable — is rejected before any AAD is built.
    expect(() => projectApiKeyAad(SLUG)).toThrow(InvalidProjectSecretScopeError);
    expect(() => projectHookTokenAad(`project:${UUID}`)).toThrow(InvalidProjectSecretScopeError);
  });

  it('is the AAD the existing v2 repository path binds for (project:<uuid>, hook_token)', () => {
    const repo = new SecretsRepository();
    repo.set(projectSecretScope(UUID), PROJECT_HOOK_TOKEN_NAME, 'synthetic-hook-token');
    const row = getDb()
      .prepare('SELECT payload FROM secrets WHERE scope = ? AND name = ?')
      .get(projectSecretScope(UUID), PROJECT_HOOK_TOKEN_NAME) as { payload: string };
    // Decrypting through the declared contract AAD proves the two spellings of
    // the binding are the same bytes — without any new code path calling
    // columnAad with a colon inside the rowId.
    expect(decrypt(row.payload, projectHookTokenAad(UUID))).toBe('synthetic-hook-token');
  });
});
