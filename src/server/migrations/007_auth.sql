-- M1.4 replaces the lockout mechanism from 005 with a progressive response
-- delay, and adds the tables authentication needs.
--
-- 005 is left exactly as it was written: a migration that has already run
-- somewhere must never be edited in place. It is undone here instead.
--
-- Why the lockout goes away: a lockout keyed on the client IP inconveniences
-- the legitimate operator (who connects through tunnels with rotating
-- addresses) while an attacker rotates addresses for free. A lockout keyed on
-- the single account turns any attacker into a denial-of-service against the
-- only user there is. Neither trade is worth making, so nothing in the
-- authentication path branches on the client IP or locks anything out. The
-- replacement is a single global counter of consecutive failures driving a
-- target response time, combined with single-flight execution so parallel
-- attempts cannot serve their delays simultaneously.

DROP TABLE lockouts;

-- Exactly one row, for the one account. Not keyed by scope: there is nothing to
-- key it on, which is the point.
CREATE TABLE auth_failures (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_at TEXT
);

INSERT INTO auth_failures (id, consecutive_failures) VALUES (1, 0);

-- Single-use recovery codes. Only the argon2 hash is stored; the plaintext is
-- shown exactly once, at generation.
CREATE TABLE recovery_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_recovery_codes_user ON recovery_codes (user_id);

-- 002 gave sessions a single `expires_at`. Idle timeout and absolute lifetime
-- are two different deadlines and a sliding renewal must move only the first,
-- so the second needs its own column.
--
-- `auth_level` separates a session that has passed the password step from one
-- that has passed both factors. A 'pre' session can reach the second-factor and
-- enrolment endpoints and nothing else, which is what makes it safe to hand out
-- a cookie between the two steps of a login.
--
-- Nothing has ever written to `sessions` -- M1.4 is the first writer -- so there
-- is nothing to backfill. A hypothetical legacy row would have a NULL
-- `absolute_expires_at`, which the session service treats as expired: the safe
-- direction.
ALTER TABLE sessions ADD COLUMN absolute_expires_at TEXT;
ALTER TABLE sessions ADD COLUMN auth_level TEXT NOT NULL DEFAULT 'full';
