-- Workspace attribution, added 2026-10-28. Databases created before then
-- lack the column; fresh databases get it right after 0001. The ALTER is
-- not idempotent (SQLite has no ADD COLUMN IF NOT EXISTS), so databases
-- that already have team_id must mark this migration as applied instead of
-- re-running it — see the README's "Already installed?" note.
ALTER TABLE events ADD COLUMN team_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_events_team_date ON events (team_id, date_ms);
