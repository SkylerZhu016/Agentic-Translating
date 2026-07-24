-- 0003_vnext_bidirectional_agents.sql
-- Direction-aware agent catalogue, revisioned workflow presets, resumable runs,
-- evidence-carrying edits, and batch jobs.

ALTER TABLE endpoints ADD COLUMN context_window INTEGER;

ALTER TABLE sessions ADD COLUMN direction TEXT NOT NULL DEFAULT 'en_to_zh';
ALTER TABLE sessions ADD COLUMN task_brief TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN review_mode TEXT NOT NULL DEFAULT 'main_editor';
ALTER TABLE sessions ADD COLUMN preset_revision_id TEXT;
ALTER TABLE sessions ADD COLUMN final_version_id INTEGER;
ALTER TABLE sessions ADD COLUMN batch_item_id TEXT;

ALTER TABLE final_versions ADD COLUMN parent_version_id INTEGER;
ALTER TABLE final_versions ADD COLUMN content_hash TEXT;
ALTER TABLE final_versions ADD COLUMN created_by_patch_id TEXT;

CREATE TABLE IF NOT EXISTS seed_versions (
  key TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS direction_prompt_bundles (
  direction TEXT NOT NULL,
  version INTEGER NOT NULL,
  prompt_language TEXT NOT NULL CHECK(prompt_language IN ('zh','en')),
  main_agent_prompt TEXT NOT NULL,
  worker_base_prompt TEXT NOT NULL,
  review_prompt TEXT NOT NULL,
  filter_prompt TEXT NOT NULL,
  orchestrate_prompt TEXT NOT NULL,
  assemble_prompt TEXT NOT NULL,
  editing_prompt TEXT NOT NULL,
  tool_descriptions TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(direction, version)
);

CREATE TABLE IF NOT EXISTS agent_archetypes (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name_zh TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('foundation','expression','domain','creative','adversarial')),
  tags_json TEXT NOT NULL DEFAULT '[]',
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_direction_variants (
  id TEXT PRIMARY KEY,
  archetype_id TEXT NOT NULL REFERENCES agent_archetypes(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  catalog_name TEXT NOT NULL,
  catalog_description TEXT NOT NULL,
  role_prompt TEXT NOT NULL,
  prompt_language TEXT NOT NULL CHECK(prompt_language IN ('zh','en')),
  prompt_version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  endpoint_override_id INTEGER REFERENCES endpoints(id),
  model_override TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(archetype_id, direction)
);

CREATE INDEX IF NOT EXISTS idx_agent_variants_direction
  ON agent_direction_variants(direction, enabled, sort_order);

CREATE TABLE IF NOT EXISTS workspace_drafts (
  direction TEXT PRIMARY KEY,
  source_text TEXT NOT NULL DEFAULT '',
  task_brief TEXT NOT NULL DEFAULT '',
  selected_preset_revision_id TEXT,
  allowed_agent_variant_ids TEXT NOT NULL DEFAULT '[]',
  review_mode TEXT NOT NULL DEFAULT 'main_editor',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL,
  current_revision_no INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_preset_revisions (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL REFERENCES workflow_presets(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  contract_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(preset_id, revision_no)
);

CREATE INDEX IF NOT EXISTS idx_workflow_presets_direction
  ON workflow_presets(direction, deleted_at, updated_at);

CREATE TABLE IF NOT EXISTS orchestration_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'translation',
  status TEXT NOT NULL CHECK(status IN ('queued','running','complete','failed','interrupted','cancelled')),
  phase TEXT NOT NULL DEFAULT 'team',
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_run_events_session
  ON run_events(session_id, id);

CREATE TABLE IF NOT EXISTS agent_invocations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
  agent_variant_id TEXT NOT NULL,
  agent_snapshot TEXT NOT NULL,
  endpoint_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  additional_instruction TEXT NOT NULL DEFAULT '',
  selection_reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('queued','running','complete','failed','interrupted')),
  raw_output TEXT,
  body_output TEXT,
  annotation_output TEXT,
  usage_json TEXT,
  latency_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_invocations_session
  ON agent_invocations(session_id, created_at);

CREATE TABLE IF NOT EXISTS text_patches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  base_version_id INTEGER NOT NULL REFERENCES final_versions(id),
  result_version_id INTEGER NOT NULL REFERENCES final_versions(id),
  old_text TEXT NOT NULL,
  new_text TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  diff_spans_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS batch_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  direction TEXT NOT NULL,
  preset_revision_id TEXT NOT NULL,
  preset_snapshot TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','paused','completed','failed','cancelled')),
  concurrency INTEGER NOT NULL DEFAULT 2,
  total_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  output_root TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batch_jobs(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_text TEXT NOT NULL,
  original_line_ending TEXT NOT NULL DEFAULT 'lf',
  had_bom INTEGER NOT NULL DEFAULT 0,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(batch_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_batch_items_status
  ON batch_items(batch_id, status, created_at);
