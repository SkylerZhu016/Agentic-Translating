-- Persistent user control for pausing/resuming automatic orchestration and
-- tracking whether the submitted final predates refreshed candidates.

CREATE TABLE IF NOT EXISTS session_run_controls (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  pause_requested INTEGER NOT NULL DEFAULT 0,
  candidates_stale INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO session_run_controls (session_id)
SELECT id FROM sessions;
