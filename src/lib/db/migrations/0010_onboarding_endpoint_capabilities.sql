-- Persist first-run onboarding state and independently probed endpoint
-- capabilities. The migration runner wraps this file in its own transaction.

CREATE TABLE IF NOT EXISTS onboarding_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version > 0),
  completed_at TEXT,
  dismissed_at TEXT,
  last_doctor_run_at TEXT,
  selected_endpoint_id INTEGER REFERENCES endpoints(id) ON DELETE SET NULL,
  generated_preset_revision_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO onboarding_state (id, schema_version)
VALUES (1, 1);

CREATE INDEX IF NOT EXISTS idx_onboarding_state_selected_endpoint
  ON onboarding_state(selected_endpoint_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_state_last_doctor_run
  ON onboarding_state(last_doctor_run_at);

CREATE TABLE IF NOT EXISTS endpoint_capability_profiles (
  endpoint_id INTEGER PRIMARY KEY
    REFERENCES endpoints(id) ON DELETE CASCADE,
  profile_json TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  tested_model TEXT NOT NULL,
  diagnostic_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_endpoint_capability_profiles_checked
  ON endpoint_capability_profiles(checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_endpoint_capability_profiles_expires
  ON endpoint_capability_profiles(expires_at);
