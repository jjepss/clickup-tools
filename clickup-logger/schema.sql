CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  event       TEXT NOT NULL,
  webhook_id  TEXT,
  task_id     TEXT,
  team_id     INTEGER,
  date_ms     INTEGER NOT NULL,
  field       TEXT,
  user_id     INTEGER,
  username    TEXT,
  before_json TEXT,
  after_json  TEXT,
  raw_json    TEXT,
  received_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events (date_ms);
CREATE INDEX IF NOT EXISTS idx_events_user_date ON events (user_id, date_ms);
CREATE INDEX IF NOT EXISTS idx_events_team_date ON events (team_id, date_ms);
