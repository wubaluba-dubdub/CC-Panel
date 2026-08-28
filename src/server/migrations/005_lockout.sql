CREATE TABLE lockouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,          -- 'ip:<addr>' or 'account:<username>'
  failure_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_failure_at TEXT,
  UNIQUE (scope)
);

CREATE INDEX idx_lockouts_scope ON lockouts (scope);
