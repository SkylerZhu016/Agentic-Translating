-- 0015_translation_tool_traces.sql
-- Auditable, bounded translation-domain tool calls and located review issues.

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES orchestration_runs(id) ON DELETE SET NULL,
  invocation_id TEXT REFERENCES agent_invocations(id) ON DELETE SET NULL,
  parent_tool_call_id TEXT REFERENCES agent_tool_calls(id) ON DELETE SET NULL,
  stage TEXT NOT NULL CHECK(stage IN (
    'team', 'candidate', 'draft', 'review', 'filter', 'orchestrate',
    'assemble', 'edit'
  )),
  actor TEXT NOT NULL CHECK(actor IN ('main_agent', 'review_subagent', 'user')),
  depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 1),
  schema_version TEXT NOT NULL,
  handler_version TEXT NOT NULL,
  tool_name TEXT NOT NULL CHECK(tool_name IN (
    'write_draft', 'replace_text', 'inspect_evidence',
    'search_project_memory', 'request_review', 'record_issue',
    'propose_patch'
  )),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)),
  input_summary TEXT NOT NULL DEFAULT '',
  output_summary TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'running', 'complete', 'failed', 'cancelled'
  )),
  error_code TEXT CHECK(
    error_code IS NULL OR (
      length(error_code) BETWEEN 1 AND 96
      AND instr(error_code, '?') = 0
      AND instr(error_code, '&') = 0
      AND instr(error_code, '=') = 0
      AND instr(error_code, '#') = 0
      AND instr(error_code, char(10)) = 0
      AND instr(error_code, char(13)) = 0
    )
  ),
  error_message TEXT,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(evidence_ids_json)),
  provider_seed INTEGER,
  determinism_level TEXT NOT NULL DEFAULT 'not_applicable' CHECK(
    determinism_level IN (
      'local_deterministic', 'seeded_best_effort', 'provider_default',
      'not_applicable'
    )
  ),
  base_version_id INTEGER,
  old_text_hash TEXT,
  old_text_length INTEGER,
  replacement_hash TEXT,
  replacement_length INTEGER,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK(parent_tool_call_id IS NULL OR parent_tool_call_id <> id),
  CHECK(
    (status = 'running' AND completed_at IS NULL)
    OR (status <> 'running' AND completed_at IS NOT NULL)
  ),
  CHECK(
    (status IN ('failed', 'cancelled')
      AND error_code IS NOT NULL
      AND output_json IS NULL
      AND output_summary IS NULL)
    OR
    (status = 'complete'
      AND error_code IS NULL
      AND error_message IS NULL
      AND output_json IS NOT NULL
      AND output_json <> 'null')
    OR
    (status = 'running'
      AND error_code IS NULL
      AND error_message IS NULL
      AND output_json IS NULL
      AND output_summary IS NULL)
  ),
  CHECK(
    (tool_name = 'propose_patch'
      AND base_version_id IS NOT NULL
      AND old_text_hash NOT GLOB '*[^0-9a-f]*' AND length(old_text_hash) = 64
      AND old_text_length > 0
      AND replacement_hash NOT GLOB '*[^0-9a-f]*' AND length(replacement_hash) = 64
      AND replacement_length >= 0)
    OR
    (tool_name <> 'propose_patch'
      AND base_version_id IS NULL
      AND old_text_hash IS NULL
      AND old_text_length IS NULL
      AND replacement_hash IS NULL
      AND replacement_length IS NULL)
  ),
  CHECK(
    (provider_seed IS NULL AND determinism_level IN (
      'provider_default', 'not_applicable', 'local_deterministic'
    ))
    OR
    (provider_seed IS NOT NULL AND determinism_level = 'seeded_best_effort')
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_session_created
  ON agent_tool_calls(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_run_stage_created
  ON agent_tool_calls(run_id, stage, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_invocation_created
  ON agent_tool_calls(invocation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_parent_created
  ON agent_tool_calls(parent_tool_call_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_tool_status_created
  ON agent_tool_calls(tool_name, status, created_at);

CREATE TRIGGER IF NOT EXISTS trg_agent_tool_calls_terminal_immutable
BEFORE UPDATE OF status ON agent_tool_calls
WHEN OLD.status <> 'running' AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'terminal agent tool calls are immutable');
END;

CREATE TABLE IF NOT EXISTS review_issues (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES orchestration_runs(id) ON DELETE SET NULL,
  invocation_id TEXT REFERENCES agent_invocations(id) ON DELETE SET NULL,
  source_tool_call_id TEXT REFERENCES agent_tool_calls(id) ON DELETE SET NULL,
  stage TEXT NOT NULL CHECK(stage IN (
    'team', 'candidate', 'draft', 'review', 'filter', 'orchestrate',
    'assemble', 'edit'
  )),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 240),
  details TEXT NOT NULL CHECK(length(trim(details)) BETWEEN 1 AND 8000),
  location_json TEXT NOT NULL CHECK(json_valid(location_json)),
  category TEXT NOT NULL CHECK(category IN (
    'fidelity', 'logic', 'naturalness', 'terminology', 'style', 'format',
    'task_constraint', 'other'
  )),
  severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open', 'resolved', 'dismissed')),
  evidence_ids_json TEXT NOT NULL CHECK(json_valid(evidence_ids_json)),
  resolution TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK(
    (status = 'open' AND resolved_at IS NULL)
    OR (status IN ('resolved', 'dismissed') AND resolved_at IS NOT NULL)
  ),
  CHECK(status <> 'open' OR resolution IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_review_issues_session_status_created
  ON review_issues(session_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_review_issues_run_stage_created
  ON review_issues(run_id, stage, created_at);

CREATE INDEX IF NOT EXISTS idx_review_issues_source_tool
  ON review_issues(source_tool_call_id);

CREATE INDEX IF NOT EXISTS idx_review_issues_category_severity
  ON review_issues(category, severity, created_at);
