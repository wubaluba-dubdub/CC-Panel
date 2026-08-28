CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  event TEXT NOT NULL,
  actor_ip TEXT,
  user_agent TEXT,
  outcome TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_audit_log_ts ON audit_log (ts);
CREATE INDEX idx_audit_log_event ON audit_log (event);
