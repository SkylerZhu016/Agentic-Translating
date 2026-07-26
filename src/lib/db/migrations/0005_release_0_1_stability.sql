-- Release 0.1.x stability: explicit endpoint paths, idempotent sessions,
-- retry lineage, direction-level model profiles, and revisioned prompt packs.

ALTER TABLE endpoints
  ADD COLUMN chat_completions_path TEXT NOT NULL DEFAULT '/v1/chat/completions';

ALTER TABLE sessions ADD COLUMN client_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_client_request_id
  ON sessions(client_request_id)
  WHERE client_request_id IS NOT NULL;

ALTER TABLE agent_invocations ADD COLUMN replaces_invocation_id TEXT;
ALTER TABLE agent_invocations
  ADD COLUMN binding_source TEXT NOT NULL DEFAULT 'frozen'
  CHECK(binding_source IN ('frozen','current'));
ALTER TABLE agent_invocations
  ADD COLUMN binding_snapshot_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_agent_invocations_replaces
  ON agent_invocations(replaces_invocation_id);

ALTER TABLE workspace_drafts ADD COLUMN prompt_bundle_revision_id TEXT;

CREATE TABLE IF NOT EXISTS workspace_model_profiles (
  direction TEXT PRIMARY KEY,
  default_worker_json TEXT NOT NULL,
  main_agent_json TEXT NOT NULL,
  editing_agent_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_bundle_families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  direction TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  current_revision_no INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_bundle_revisions (
  id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL REFERENCES prompt_bundle_families(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bundle_id, revision_no)
);

CREATE INDEX IF NOT EXISTS idx_prompt_bundle_families_direction
  ON prompt_bundle_families(direction, is_builtin, deleted_at);

INSERT OR IGNORE INTO workspace_model_profiles (
  direction, default_worker_json, main_agent_json, editing_agent_json
) VALUES
  ('en_to_zh', '{"endpointId":null,"model":"","contextWindow":null}', '{"endpointId":null,"model":"","contextWindow":null}', '{"endpointId":null,"model":"","contextWindow":null}'),
  ('zh_to_en', '{"endpointId":null,"model":"","contextWindow":null}', '{"endpointId":null,"model":"","contextWindow":null}', '{"endpointId":null,"model":"","contextWindow":null}');
