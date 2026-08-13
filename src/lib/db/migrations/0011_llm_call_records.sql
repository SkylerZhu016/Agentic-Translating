-- 0011_llm_call_records.sql
-- Unified, privacy-safe accounting for every physical LLM request.
-- Prompt text, source/translated text, endpoint URLs, URL query strings and
-- API keys deliberately have no columns in this table.

CREATE TABLE IF NOT EXISTS llm_call_records (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES orchestration_runs(id) ON DELETE SET NULL,
  invocation_id TEXT REFERENCES agent_invocations(id) ON DELETE SET NULL,
  -- endpoint_id is an immutable numeric snapshot rather than a foreign key:
  -- deleting endpoint configuration must not erase or block audit history.
  endpoint_id INTEGER NOT NULL CHECK(endpoint_id > 0),
  operation TEXT NOT NULL CHECK(
    length(operation) BETWEEN 1 AND 80
    AND instr(operation, '?') = 0
    AND instr(operation, '&') = 0
    AND instr(operation, '=') = 0
    AND instr(operation, '#') = 0
    AND instr(operation, char(10)) = 0
    AND instr(operation, char(13)) = 0
  ),
  requested_model TEXT NOT NULL CHECK(
    length(requested_model) BETWEEN 1 AND 200
    AND instr(requested_model, '://') = 0
    AND instr(requested_model, '?') = 0
    AND instr(requested_model, '&') = 0
    AND instr(requested_model, '=') = 0
    AND instr(requested_model, '#') = 0
    AND instr(requested_model, char(10)) = 0
    AND instr(requested_model, char(13)) = 0
  ),
  response_model TEXT CHECK(
    response_model IS NULL OR (
      length(response_model) BETWEEN 1 AND 200
      AND instr(response_model, '://') = 0
      AND instr(response_model, '?') = 0
      AND instr(response_model, '&') = 0
      AND instr(response_model, '=') = 0
      AND instr(response_model, '#') = 0
      AND instr(response_model, char(10)) = 0
      AND instr(response_model, char(13)) = 0
    )
  ),
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'connecting', 'receiving', 'complete', 'failed', 'cancelled'
  )),
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens INTEGER CHECK(reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  usage_source TEXT NOT NULL DEFAULT 'unknown'
    CHECK(usage_source IN ('provider', 'estimated', 'unknown')),
  first_byte_ms INTEGER CHECK(first_byte_ms IS NULL OR first_byte_ms >= 0),
  latency_ms INTEGER CHECK(latency_ms IS NULL OR latency_ms >= 0),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
  price_snapshot_json TEXT,
  cost_amount REAL CHECK(cost_amount IS NULL OR cost_amount >= 0),
  cost_currency TEXT CHECK(
    cost_currency IS NULL OR (
      length(cost_currency) = 3 AND cost_currency = upper(cost_currency)
    )
  ),
  cost_source TEXT NOT NULL DEFAULT 'unknown'
    CHECK(cost_source IN ('provider', 'estimated', 'unknown')),
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK(
    (usage_source = 'unknown'
      AND input_tokens IS NULL
      AND output_tokens IS NULL
      AND reasoning_tokens IS NULL)
    OR
    (usage_source IN ('provider', 'estimated')
      AND (input_tokens IS NOT NULL
        OR output_tokens IS NOT NULL
        OR reasoning_tokens IS NOT NULL))
  ),
  CHECK(
    (cost_source = 'unknown'
      AND cost_amount IS NULL
      AND cost_currency IS NULL
      AND price_snapshot_json IS NULL)
    OR
    (cost_source = 'provider'
      AND cost_amount IS NOT NULL
      AND cost_currency IS NOT NULL
      AND price_snapshot_json IS NULL)
    OR
    (cost_source = 'estimated'
      AND cost_amount IS NOT NULL
      AND cost_currency IS NOT NULL
      AND price_snapshot_json IS NOT NULL)
  ),
  CHECK(
    (status IN ('failed', 'cancelled') AND error_code IS NOT NULL)
    OR
    (status NOT IN ('failed', 'cancelled') AND error_code IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_llm_call_records_session_created
  ON llm_call_records(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_llm_call_records_run_created
  ON llm_call_records(run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_llm_call_records_invocation_created
  ON llm_call_records(invocation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_llm_call_records_endpoint_model_created
  ON llm_call_records(endpoint_id, requested_model, created_at);

CREATE INDEX IF NOT EXISTS idx_llm_call_records_status_created
  ON llm_call_records(status, created_at);

CREATE INDEX IF NOT EXISTS idx_llm_call_records_operation_created
  ON llm_call_records(operation, created_at);
