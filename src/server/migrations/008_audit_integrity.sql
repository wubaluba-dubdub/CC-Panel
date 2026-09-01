-- Migration 008: make the audit log append-only and tamper-evident.
--
-- Two independent controls, because they defend against different attackers:
--
-- 1. Triggers. SQLite refuses UPDATE and DELETE on a chained row, so a bug — or a
--    route reached through the application — cannot rewrite history. This stops
--    everything that goes through this connection.
-- 2. A hash chain, keyed with an HKDF subkey of the master key. Every row stores
--    the previous row's hash and its own HMAC over that plus a canonical
--    serialisation of its columns. An attacker holding only the database file can
--    drop the triggers with two statements, so the triggers alone prove nothing;
--    what they cannot do without PANEL_MASTER_KEY is recompute the chain. This is
--    why the chain is an HMAC and not a bare SHA-256: a bare digest is
--    recomputable by anyone who can read the rows.

ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
ALTER TABLE audit_log ADD COLUMN row_hash TEXT;

-- The chain's own state: one row, forever.
--
--  anchor_hash  the hash of the newest row — stored outside the chain so that
--               truncating the head is detectable. Without it, deleting the last
--               five rows leaves a perfectly self-consistent chain.
--  floor_hash   the hash the oldest surviving row must point back to. 'genesis'
--               until retention trims something, then the hash of the last row
--               that was dropped, so the survivors stay anchored and verification
--               after a legitimate trim still passes.
--  floor_id     the id trimming has removed through, for the operator's benefit.
--  trim_unlocked  the one gate the DELETE trigger honours. Retention flips it
--               inside its own transaction; nothing else ever sets it.
CREATE TABLE audit_chain (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  anchor_hash   TEXT    NOT NULL,
  floor_hash    TEXT    NOT NULL,
  floor_id      INTEGER NOT NULL DEFAULT 0,
  trim_unlocked INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO audit_chain (id, anchor_hash, floor_hash, floor_id, trim_unlocked)
VALUES (1, 'genesis', 'genesis', 0, 0);

-- `WHEN OLD.row_hash IS NOT NULL` is what makes writing possible at all: a row is
-- inserted with row_hash NULL and immediately updated with its hash inside one
-- transaction, because the hash covers the row's own AUTOINCREMENT id and cannot be
-- computed before the insert. That single UPDATE is the only one SQLite will ever
-- accept on this table; from then on the row is frozen. It also lets migration-time
-- backfill chain the rows M1.4 wrote before this migration existed.
CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
WHEN OLD.row_hash IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE rejected');
END;

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
WHEN (SELECT trim_unlocked FROM audit_chain WHERE id = 1) = 0
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: DELETE rejected');
END;

-- Retention deletes from the oldest id upward, and the query API pages on id
-- descending; both are covered by the primary key. This index serves the time-range
-- filter, which is a bounded scan rather than a sort.
CREATE INDEX IF NOT EXISTS idx_audit_log_event_id ON audit_log (event, id DESC);
