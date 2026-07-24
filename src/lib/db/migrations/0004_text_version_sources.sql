-- 0004_text_version_sources.sql
-- Preserve the semantic source of every append-only text version. SQLite
-- cannot extend a CHECK constraint in place, so rebuild the three tables
-- whose foreign keys point at final_versions.

ALTER TABLE chat_messages RENAME TO chat_messages_v3;
ALTER TABLE text_patches RENAME TO text_patches_v3;
ALTER TABLE final_versions RENAME TO final_versions_v3;

CREATE TABLE final_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK(
    source IN ('assemble','main_draft','edit','restore','revert')
  ),
  created_at TEXT DEFAULT (datetime('now')),
  parent_version_id INTEGER,
  content_hash TEXT,
  created_by_patch_id TEXT,
  UNIQUE(session_id, version_no)
);

INSERT INTO final_versions (
  id, session_id, version_no, text, source, created_at,
  parent_version_id, content_hash, created_by_patch_id
)
SELECT
  id, session_id, version_no, text, source, created_at,
  parent_version_id, content_hash, created_by_patch_id
FROM final_versions_v3;

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
  content TEXT NOT NULL DEFAULT '',
  tool_calls TEXT,
  tool_results TEXT,
  version_id INTEGER REFERENCES final_versions(id),
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO chat_messages (
  id, session_id, role, content, tool_calls, tool_results, version_id, created_at
)
SELECT
  id, session_id, role, content, tool_calls, tool_results, version_id, created_at
FROM chat_messages_v3;

CREATE TABLE text_patches (
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

INSERT INTO text_patches (
  id, session_id, base_version_id, result_version_id, old_text, new_text,
  reason, evidence_refs_json, diff_spans_json, created_at
)
SELECT
  id, session_id, base_version_id, result_version_id, old_text, new_text,
  reason, evidence_refs_json, diff_spans_json, created_at
FROM text_patches_v3;

DROP TABLE chat_messages_v3;
DROP TABLE text_patches_v3;
DROP TABLE final_versions_v3;
