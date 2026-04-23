-- 0001_init.sql: Initial schema for Agentic Translating
-- 8 domain tables + metadata
-- All tables use TEXT for datetimes (ISO 8601) for portability
-- NOTE: Migration runner wraps this in a transaction, no BEGIN/COMMIT here.

-- 1. API endpoint configurations (BYOK — bring your own key)
CREATE TABLE IF NOT EXISTS endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 2. Prompt templates (built-in + user overrides)
CREATE TABLE IF NOT EXISTS prompt_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('translator','review','filter','orchestrate','assemble')),
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  is_builtin INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 3. Translator agents (parallel translation workers)
CREATE TABLE IF NOT EXISTS translator_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  endpoint_id INTEGER NOT NULL REFERENCES endpoints(id),
  model TEXT NOT NULL,
  prompt_override TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 4. Coordinator configuration (singleton row via CHECK id=1)
CREATE TABLE IF NOT EXISTS coordinator_config (
  id INTEGER PRIMARY KEY CHECK(id=1),
  endpoint_id INTEGER REFERENCES endpoints(id),
  model TEXT NOT NULL DEFAULT '',
  chat_endpoint_id INTEGER REFERENCES endpoints(id),
  chat_model TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 5. Key-value settings (e.g., flash warning dismissed)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 6. Translation sessions (state machine)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source_text TEXT NOT NULL,
  source_lang TEXT NOT NULL DEFAULT '英文',
  target_lang TEXT NOT NULL DEFAULT '中文五言',
  state TEXT NOT NULL DEFAULT 'draft',
  config_snapshot TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 7. Per-agent translation results
CREATE TABLE IF NOT EXISTS translation_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_key TEXT NOT NULL,
  agent_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','streaming','complete','error')),
  output_text TEXT,
  error TEXT,
  latency_ms INTEGER,
  attempt INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(session_id, agent_key)
);

-- 8. Four-stage coordinator outputs
CREATE TABLE IF NOT EXISTS stage_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('review','filter','orchestrate','assemble')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','complete','failed','stale')),
  prompt_used TEXT,
  raw_output TEXT,
  parsed_output TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(session_id, stage)
);

-- 9. Final version history (append-only per session)
CREATE TABLE IF NOT EXISTS final_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('assemble','edit','restore')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(session_id, version_no)
);

-- 10. Chat messages (conversation history for editing)
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
  content TEXT NOT NULL DEFAULT '',
  tool_calls TEXT,
  tool_results TEXT,
  version_id INTEGER REFERENCES final_versions(id),
  created_at TEXT DEFAULT (datetime('now'))
);
