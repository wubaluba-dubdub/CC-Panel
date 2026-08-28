CREATE TABLE users (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- exactly one user
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret_encrypted TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  last_totp_step INTEGER NOT NULL DEFAULT 0,
  recovery_codes_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
