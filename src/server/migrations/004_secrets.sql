CREATE TABLE secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,          -- 'global' or 'project:<id>'
  name TEXT NOT NULL,           -- e.g. 'anthropic_auth_token'
  ciphertext TEXT NOT NULL,     -- base64 AES-256-GCM
  nonce TEXT NOT NULL,          -- base64 96-bit nonce
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scope, name)
);
