-- Migration 012: `projects` — M2.2A.
--
-- Identity is the uuid; the slug is a mutable label. Renaming a project rewrites the
-- slug and nothing else — no directory move, no re-encryption, no AAD change — because
-- nothing durable is keyed on the slug. The uuid is server-generated
-- (crypto.randomUUID()) and never changes.
--
-- UNIQUE(slug) compares bytes. Uniqueness "after NFC normalisation and case folding"
-- is therefore a two-layer guarantee: the validation layer (M2.2B) only admits slugs
-- that already pass ^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$ — a grammar on which NFC
-- normalisation and case folding are both identity operations — and this UNIQUE then
-- enforces uniqueness over exactly those canonical forms. SQLite has neither
-- normalisation nor case folding, so the schema cannot own that half; the validator
-- is the layer that must not be bypassed.
CREATE TABLE projects (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid             TEXT    NOT NULL UNIQUE,
  slug             TEXT    NOT NULL UNIQUE,
  isolated_settings INTEGER NOT NULL DEFAULT 0 CHECK (isolated_settings IN (0, 1)),
  created_at       TEXT    NOT NULL,
  -- Seven import columns for R8 (M2.8), declared now so that milestone never needs
  -- a second `projects` migration. Deliberately unused: nothing reads them and
  -- nothing writes them until then. NULL means "not imported".
  origin            TEXT,
  origin_ref        TEXT,
  origin_at         TEXT,
  source_install_id TEXT,
  review_state      TEXT,
  reviewed_at       TEXT,
  artefacts_json    TEXT
);
