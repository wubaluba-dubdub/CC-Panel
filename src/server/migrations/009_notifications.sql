-- Migration 009: the notification queue, and two corrections to `secrets`.
--
-- ── The queue ───────────────────────────────────────────────────────────────
--
-- A table and not an in-memory array, because delivery is always asynchronous and
-- has to survive a restart. Nothing in a request path ever waits on
-- api.telegram.org: `notify()` is one INSERT inside whatever transaction the caller
-- is already in, and a single worker drains it afterwards. So the worst a broken
-- Telegram configuration can do to a request is nothing at all.
--
-- `event_json` holds the **typed event**, not rendered text. A transport decides its
-- own formatting — Telegram's 4096-character cap and its truncate-then-attach
-- behaviour are properties of Telegram, not of "a notification" — and a pre-rendered
-- string would force a later SMTP or ntfy transport to accept Telegram's shape. The
-- event's string fields are redacted and base-path-elided **before** the row is
-- written, because this table persists on the volume: redacting at send time would
-- leave the base path sitting in a database file.
CREATE TABLE notification_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT    NOT NULL,
  -- The discriminant of the typed event, duplicated out of `event_json` so a query
  -- can filter on it without parsing every row.
  kind            TEXT    NOT NULL CHECK (
                    kind IN ('turn_complete', 'resource_alert', 'security_alert', 'test')
                  ),
  event_json      TEXT    NOT NULL,
  -- The one sanctioned exception to "the server does not translate": a Telegram
  -- message has no client to render it, so the event carries the locale it should be
  -- rendered in.
  locale          TEXT    NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'fa')),
  -- Four states, not five. The design sketched a `failed` state as well; with retries
  -- it is indistinguishable from `pending` carrying a `last_error`, and two names for
  -- one condition is how a worker ends up with a row nothing will ever pick up.
  state           TEXT    NOT NULL DEFAULT 'pending' CHECK (
                    state IN ('pending', 'sending', 'sent', 'abandoned')
                  ),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT    NOT NULL,
  -- Which throttle bucket this row belongs to, from `notification-rules.ts`. A column
  -- rather than a field inside `event_json`, because the throttle query runs on every
  -- audit write and reading it should not mean parsing every row's JSON.
  throttle_key    TEXT,
  -- A category, never a response body: Telegram's error payloads echo request
  -- parameters, and one of the request parameters is the bot token.
  last_error      TEXT,
  -- When the current attempt claimed the row. Only the boot sweep reads it.
  claimed_at      TEXT,
  sent_at         TEXT
);

-- The worker's only query: the oldest due pending row.
CREATE INDEX idx_notification_queue_due ON notification_queue (state, next_attempt_at, id);

-- The throttle query: the newest row for one bucket.
CREATE INDEX idx_notification_queue_throttle ON notification_queue (throttle_key, id DESC);

-- One row, forever. The drop counter is the queue-cap policy's memory: when the
-- queue is full, new events are refused rather than evicting older ones (the first
-- alert of an attack is the most valuable, and the newest is the most expendable),
-- and the operator has to be able to find out that it happened.
CREATE TABLE notification_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  dropped       INTEGER NOT NULL DEFAULT 0,
  dropped_since TEXT,
  updated_at    TEXT
);

INSERT INTO notification_state (id, dropped, dropped_since, updated_at)
VALUES (1, 0, NULL, NULL);

-- ── `secrets.created_at` / `updated_at` were written in the wrong format ─────
--
-- Both columns default to SQLite's `datetime('now')`, which is
-- `YYYY-MM-DD HH:MM:SS` — UTC with **no zone marker**. Every other timestamp this
-- project writes goes through `isoFrom()` and carries an explicit `Z`. Served raw to
-- a browser, the unmarked form is parsed as *local* time, so the secrets screen
-- becomes the one place whose times are wrong — by exactly this operator's +03:30,
-- and a Jalali calendar would hide the discrepancy rather than reveal it.
--
-- `SecretsRepository` now supplies both columns explicitly from the injected clock;
-- this normalises whatever the DEFAULT wrote before that. The column defaults stay
-- as they are: changing a DEFAULT in SQLite means rebuilding the table, and no code
-- path relies on them any more.
UPDATE secrets
   SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
 WHERE created_at IS NOT NULL AND created_at NOT LIKE '%Z';

UPDATE secrets
   SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
 WHERE updated_at IS NOT NULL AND updated_at NOT LIKE '%Z';
