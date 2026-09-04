-- Migration 010: the resource watchdog's crossing state, and two more event kinds.
--
-- ── Why both tables are rebuilt rather than ALTERed ──────────────────────────
--
-- SQLite cannot alter a CHECK constraint. `notification_queue.kind` enumerates the
-- typed events the queue may hold, and M1.8 adds two of them, so the table is
-- rebuilt around a widened list. The rows are copied first: a pending row is an
-- alert the operator has not been told about yet, and the queue is the only place it
-- exists.
--
-- `notification_state` is rebuilt for the same reason — the crossing columns want
-- CHECK constraints, and `ALTER TABLE ADD COLUMN` is a poor place to put one. It is
-- a single row, so the copy is one row.
--
-- ── Why the crossing state is here and not in a table of its own ─────────────
--
-- It is notification state: what the panel has already told the operator, which is
-- exactly what `dropped` beside it records. One row is read per watchdog tick and
-- written only when something actually changed, so an idle panel does not dirty a
-- page every thirty seconds.
--
-- The one piece of watchdog state that is deliberately **not** here is the run
-- marker (`/data/run/panel.run`). Its *absence* is the signal, so it must be
-- readable by a boot that has not opened the database yet — and the crash it exists
-- to detect is exactly the kind that can involve the database or the volume.

-- ── notification_queue: two new kinds ───────────────────────────────────────
--
-- `oom_kill`     — the cgroup's `memory.events` oom_kill counter went up. Something
--                  in this container was killed for memory; usually a child, since
--                  a kill that takes the panel cannot be reported by the panel.
-- `unclean_restart` — the previous run left its marker behind, so it was not given
--                  the chance to shut down or did not take it.
--
-- Both are their own kind rather than a flag inside `resource_alert`, because
-- neither carries a fraction: one is a count of processes, the other is a pair of
-- timestamps. Sharing the kind would have made `percent` meaningless in two of the
-- four messages the watchdog can send.
CREATE TABLE notification_queue_v2 (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT    NOT NULL,
  kind            TEXT    NOT NULL CHECK (
                    kind IN (
                      'turn_complete',
                      'resource_alert',
                      'security_alert',
                      'test',
                      'oom_kill',
                      'unclean_restart'
                    )
                  ),
  event_json      TEXT    NOT NULL,
  locale          TEXT    NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'fa')),
  state           TEXT    NOT NULL DEFAULT 'pending' CHECK (
                    state IN ('pending', 'sending', 'sent', 'abandoned')
                  ),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT    NOT NULL,
  throttle_key    TEXT,
  last_error      TEXT,
  claimed_at      TEXT,
  sent_at         TEXT
);

-- Explicit column lists on both sides, so a future column added to one and not the
-- other fails here rather than shifting values into the wrong columns.
INSERT INTO notification_queue_v2
  (id, created_at, kind, event_json, locale, state, attempts, next_attempt_at,
   throttle_key, last_error, claimed_at, sent_at)
SELECT
   id, created_at, kind, event_json, locale, state, attempts, next_attempt_at,
   throttle_key, last_error, claimed_at, sent_at
  FROM notification_queue;

DROP TABLE notification_queue;
ALTER TABLE notification_queue_v2 RENAME TO notification_queue;

-- Dropped with the old table, so both are recreated by name and by definition.
CREATE INDEX idx_notification_queue_due ON notification_queue (state, next_attempt_at, id);
CREATE INDEX idx_notification_queue_throttle ON notification_queue (throttle_key, id DESC);

-- ── notification_state: the crossing machine's memory ───────────────────────
--
-- Four columns per threshold rule, and each one is load-bearing:
--
--   *_state       'below' | 'above'. This is what makes an alert fire on a
--                 **crossing** rather than on a level: a sustained 95 % stays
--                 'above' and emits nothing, so it is one message and not one every
--                 thirty seconds.
--   *_since       when it entered 'above', so the recovery message can say how long
--                 it was there. Null while below.
--   *_alerted     whether the operator was actually **told**. Distinct from the
--                 state because the cooldown can swallow an alert, and a recovery
--                 for an alert that was never sent is a message about nothing.
--                 Silence is unambiguous in both directions: every alert that was
--                 sent gets a recovery, and nothing else does.
--   *_last_alert_at  the cooldown's clock. Hysteresis stops chatter on the boundary;
--                 this bounds a workload genuinely swinging through the whole band.
--
-- `oom_kills` is nullable, and NULL is not zero: it means "no baseline has been read
-- yet", so the first sample after an upgrade adopts whatever the counter says
-- instead of reporting every kill that happened before this build existed. A value
-- lower than the stored one is a new cgroup — a container restart — and resets the
-- baseline rather than reporting a negative delta.
CREATE TABLE notification_state_v2 (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  dropped              INTEGER NOT NULL DEFAULT 0,
  dropped_since        TEXT,
  updated_at           TEXT,
  memory_state         TEXT    NOT NULL DEFAULT 'below' CHECK (memory_state IN ('below', 'above')),
  memory_since         TEXT,
  memory_alerted       INTEGER NOT NULL DEFAULT 0 CHECK (memory_alerted IN (0, 1)),
  memory_last_alert_at TEXT,
  disk_state           TEXT    NOT NULL DEFAULT 'below' CHECK (disk_state IN ('below', 'above')),
  disk_since           TEXT,
  disk_alerted         INTEGER NOT NULL DEFAULT 0 CHECK (disk_alerted IN (0, 1)),
  disk_last_alert_at   TEXT,
  oom_kills            INTEGER
);

INSERT INTO notification_state_v2 (id, dropped, dropped_since, updated_at)
SELECT id, dropped, dropped_since, updated_at FROM notification_state;

DROP TABLE notification_state;
ALTER TABLE notification_state_v2 RENAME TO notification_state;

-- Belt for the braces. Migration 009 inserts this row, so this is a no-op on every
-- database that has one — but every reader of this table assumes the row exists, and
-- a watchdog that cannot read its own state would be a watchdog that alerts on
-- nothing.
INSERT OR IGNORE INTO notification_state (id) VALUES (1);
