-- 0002_presets_and_drop_parsed_output.sql: Config presets + drop parsed_output
-- NOTE: Migration runner wraps this in a transaction, no BEGIN/COMMIT here.

-- 1. Config presets (built-in templates for translation config)
CREATE TABLE IF NOT EXISTS config_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_builtin INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 2. Preset translator agents (per preset)
CREATE TABLE IF NOT EXISTS config_preset_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preset_id INTEGER NOT NULL REFERENCES config_presets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  endpoint_id INTEGER REFERENCES endpoints(id),
  model TEXT NOT NULL,
  prompt_override TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- 3. Preset coordinator config (singleton per preset)
CREATE TABLE IF NOT EXISTS config_preset_coordinator (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preset_id INTEGER NOT NULL UNIQUE REFERENCES config_presets(id) ON DELETE CASCADE,
  endpoint_id INTEGER REFERENCES endpoints(id),
  model TEXT NOT NULL DEFAULT '',
  chat_endpoint_id INTEGER REFERENCES endpoints(id),
  chat_model TEXT NOT NULL DEFAULT ''
);

-- 4. Preset prompts (one per kind per preset)
CREATE TABLE IF NOT EXISTS config_preset_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preset_id INTEGER NOT NULL REFERENCES config_presets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('translator','review','filter','orchestrate','assemble')),
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  UNIQUE(preset_id, kind)
);

-- 5. Drop stage_outputs.parsed_output column (SQLite: recreate without the column)
CREATE TABLE IF NOT EXISTS stage_outputs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('review','filter','orchestrate','assemble')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','complete','failed','stale')),
  prompt_used TEXT,
  raw_output TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(session_id, stage)
);

INSERT INTO stage_outputs_new (id, session_id, stage, status, prompt_used, raw_output, error, created_at)
SELECT id, session_id, stage, status, prompt_used, raw_output, error, created_at FROM stage_outputs;

DROP TABLE stage_outputs;

ALTER TABLE stage_outputs_new RENAME TO stage_outputs;
