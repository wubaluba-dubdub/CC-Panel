-- Migration 012: the `projects` table — M2.2's portable project identity.
--
-- ── Why the seven import columns exist now ───────────────────────────────────
--
-- M2.8 adds an import feature that needs columns for origin, review state, and
-- artefact metadata. Adding them in M2.8 would require an ALTER TABLE against
-- live operator data — expensive on SQLite and fragile in a migration that may
-- run on a database with many rows. By declaring them now, M2.8 adds its own
-- repository code without a table rewrite. These columns are UNUSED as of this
-- commit: no reader, no writer, no validation, no type that pretends they are
-- populated. The milestone that will populate each one is noted below.
--
-- ── Identity vs. label ──────────────────────────────────────────────────────
--
-- `uuid` is the identity; `slug` is the mutable label. Renaming a project
-- changes only `slug` — it must not move a folder on disk and must not
-- invalidate an encryption AAD keyed on `uuid`. The slug is normalised to
-- NFC and lowercased, then stored in a generated column with a UNIQUE index:
-- two inputs that fold to the same value cannot both exist, even if a future
-- code path forgets to normalise before inserting.
--
-- ── Timestamps ──────────────────────────────────────────────────────────────
--
-- `datetime('now')` defaults match the format used by every preceding
-- migration. The application code supplies ISO-8601 with an explicit `Z`
-- through the injected clock, so the defaults are a safety net, not the
-- authoritative source.
--
-- ── Single user ─────────────────────────────────────────────────────────────
--
-- No ownership column, no tenant column, no per-user scoping. There is one
-- user and every project belongs to them.
CREATE TABLE projects (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid                  TEXT    NOT NULL UNIQUE,
  slug                  TEXT    NOT NULL,
  -- NFC-normalised, lowercased slug. The UNIQUE index on this column prevents
  -- two slugs that fold to the same value from coexisting. SQLite's LOWER()
  -- is ASCII-only, which is sufficient here because the slug pattern restricts
  -- input to [a-z0-9-] — all ASCII. The repository performs full Unicode
  -- normalisation (NFC + toLowerCase) before writing, so this column is a
  -- safety net, not the sole normaliser.
  slug_normalized       TEXT    NOT NULL GENERATED ALWAYS AS (LOWER(slug)) STORED,
  isolated_settings     INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),

  -- ── M2.8 import columns (declared and unused) ──────────────────────────────
  -- These columns exist so M2.8 does not need a table rewrite against live data.
  -- As of this commit nothing reads or writes them; no repository method, no
  -- validation, no type pretends they are populated.
  --
  -- origin          TEXT  — 'zip' | 'git' | null (M2.8: import origin type)
  -- origin_ref      TEXT  — the file path or git URL (M2.8: origin reference)
  -- origin_at       TEXT  — when the import was created (M2.8: import timestamp)
  -- source_install_id TEXT — the install that exported the project (M2.8: portability)
  -- review_state    TEXT  — 'pending' | 'approved' | 'rejected' (M2.8: review state)
  -- reviewed_at     TEXT  — when the review was completed (M2.8: review timestamp)
  -- artefacts_json  TEXT  — JSON metadata about the imported artefacts (M2.8: artefact info)
  origin                TEXT,
  origin_ref            TEXT,
  origin_at             TEXT,
  source_install_id     TEXT,
  review_state          TEXT,
  reviewed_at           TEXT,
  artefacts_json        TEXT
);

-- Uniqueness on the normalised slug. This is the authoritative constraint: the
-- generated column applies LOWER() at insert time, so two slugs that differ only
-- in case are caught here rather than relying on application code to normalise.
CREATE UNIQUE INDEX idx_projects_slug_normalized ON projects (slug_normalized);
