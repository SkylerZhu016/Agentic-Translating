-- Keep history reads proportional to the requested page, including when many
-- sessions share SQLite's one-second updated_at timestamp.
CREATE INDEX IF NOT EXISTS idx_sessions_history
  ON sessions(updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_direction_history
  ON sessions(direction, updated_at DESC, id DESC);

-- Immutable ordering keeps in-flight updates from moving unread history rows
-- to an earlier page while the user browses the archive.
CREATE INDEX IF NOT EXISTS idx_sessions_created_history
  ON sessions(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_direction_created_history
  ON sessions(direction, created_at DESC, id DESC);

-- The active workspace needs the latest team decision, not token history.
CREATE INDEX IF NOT EXISTS idx_run_events_session_type
  ON run_events(session_id, event_type, id DESC);
