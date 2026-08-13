-- Bind each session idempotency key to the canonical create request that
-- produced it. Existing sessions remain valid; their record is backfilled
-- lazily after a compatible replay can be verified.

CREATE TABLE IF NOT EXISTS session_idempotency_records (
  client_request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL
    CHECK(length(request_hash) = 64),
  session_id TEXT NOT NULL UNIQUE
    REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_session_idempotency_records_session
  ON session_idempotency_records(session_id);
