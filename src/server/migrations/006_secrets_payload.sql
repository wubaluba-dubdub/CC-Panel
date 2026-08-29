-- M1.3 replaces the split ciphertext/nonce columns from 004 with a single,
-- versioned, self-describing payload: v1.<nonce>.<ciphertext>.<tag>. Keeping the
-- parts in separate columns cannot express the version, and without a version
-- there is no way to change the scheme later without guessing at the layout.
--
-- 004 created this table but nothing ever wrote to it -- M1.3 is the first
-- writer -- so there is nothing to preserve. The INSERT below is the guard for
-- that claim rather than a data migration: `payload` is NOT NULL, so if any
-- legacy row does exist the insert violates the constraint, the surrounding
-- transaction rolls back, and the migration runner throws instead of silently
-- destroying a secret nobody could re-derive.

CREATE TABLE secrets_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,          -- 'global' or 'project:<id>'
  name TEXT NOT NULL,           -- e.g. 'anthropic_auth_token'
  payload TEXT NOT NULL,        -- v1.<nonce>.<ciphertext>.<tag>, each base64url
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scope, name)
);

INSERT INTO secrets_v2 (id, scope, name, payload, created_at, updated_at)
  SELECT id, scope, name, NULL, created_at, updated_at FROM secrets;

DROP TABLE secrets;

ALTER TABLE secrets_v2 RENAME TO secrets;
