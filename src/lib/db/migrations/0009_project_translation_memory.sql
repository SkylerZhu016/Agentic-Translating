-- Project-scoped translation memory with append-only resource revisions,
-- immutable approved snapshots, review-gated suggestions, and frozen session
-- context. The migration runner wraps this file in its own transaction.

CREATE TABLE IF NOT EXISTS translation_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL CHECK(direction IN ('en_to_zh','zh_to_en','custom')),
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','archived')),
  current_snapshot_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(current_snapshot_id, id)
    REFERENCES project_snapshots(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_translation_projects_status_updated
  ON translation_projects(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_translation_projects_direction_status
  ON translation_projects(direction, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_translation_projects_current_snapshot
  ON translation_projects(current_snapshot_id);

CREATE TABLE IF NOT EXISTS project_resources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL
    REFERENCES translation_projects(id) ON DELETE RESTRICT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, idempotency_key),
  UNIQUE(id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_project_resources_project_created
  ON project_resources(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_resource_revisions (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL
    REFERENCES project_resources(id) ON DELETE RESTRICT,
  revision_no INTEGER NOT NULL CHECK(revision_no > 0),
  kind TEXT NOT NULL CHECK(kind IN (
    'term',
    'proper_noun',
    'character_voice',
    'style_rule',
    'approved_decision',
    'context_note',
    'parallel_excerpt',
    'counterexample'
  )),
  content_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'suggested','approved','rejected','retired'
  )),
  source_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(resource_id, revision_no),
  UNIQUE(resource_id, idempotency_key),
  UNIQUE(id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_project_resource_revisions_resource_revision
  ON project_resource_revisions(resource_id, revision_no DESC);
CREATE INDEX IF NOT EXISTS idx_project_resource_revisions_status_created
  ON project_resource_revisions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_resource_revisions_kind_status
  ON project_resource_revisions(kind, status, created_at DESC);

-- Resource revisions are an audit log. State changes append another revision;
-- old rows are never rewritten.
CREATE TRIGGER IF NOT EXISTS trg_project_resource_revisions_no_update
BEFORE UPDATE ON project_resource_revisions
BEGIN
  SELECT RAISE(ABORT, 'project_resource_revisions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_resource_revisions_no_delete
BEFORE DELETE ON project_resource_revisions
WHEN (SELECT user_version FROM pragma_user_version) <> 9009
BEGIN
  SELECT RAISE(ABORT, 'project_resource_revisions are immutable');
END;

CREATE TABLE IF NOT EXISTS project_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL
    REFERENCES translation_projects(id) ON DELETE RESTRICT,
  revision_no INTEGER NOT NULL CHECK(revision_no > 0),
  approved_resource_revision_ids_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by_revision_id TEXT,
  created_by_resource_id TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, revision_no),
  UNIQUE(project_id, idempotency_key),
  UNIQUE(id, project_id),
  FOREIGN KEY(created_by_revision_id, created_by_resource_id)
    REFERENCES project_resource_revisions(id, resource_id) ON DELETE RESTRICT,
  FOREIGN KEY(created_by_resource_id, project_id)
    REFERENCES project_resources(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_project_snapshots_project_revision
  ON project_snapshots(project_id, revision_no DESC);
CREATE INDEX IF NOT EXISTS idx_project_snapshots_project_created
  ON project_snapshots(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_snapshots_content_hash
  ON project_snapshots(project_id, content_hash);

-- Snapshots are immutable manifests. translation_projects.current_snapshot_id
-- is the only mutable pointer.
CREATE TRIGGER IF NOT EXISTS trg_project_snapshots_no_update
BEFORE UPDATE ON project_snapshots
BEGIN
  SELECT RAISE(ABORT, 'project_snapshots are immutable');
END;


CREATE TRIGGER IF NOT EXISTS trg_project_snapshots_no_delete
BEFORE DELETE ON project_snapshots
WHEN (SELECT user_version FROM pragma_user_version) <> 9009
BEGIN
  SELECT RAISE(ABORT, 'project_snapshots are immutable');
END;

-- Normalized membership gives the JSON manifest database-level ownership and
-- uniqueness constraints. The JSON field remains the portable public DTO.
CREATE TABLE IF NOT EXISTS project_snapshot_entries (
  snapshot_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_revision_id TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, resource_id),
  UNIQUE(snapshot_id, resource_revision_id),
  FOREIGN KEY(snapshot_id, project_id)
    REFERENCES project_snapshots(id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY(resource_id, project_id)
    REFERENCES project_resources(id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY(resource_revision_id, resource_id)
    REFERENCES project_resource_revisions(id, resource_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_project_snapshot_entries_project
  ON project_snapshot_entries(project_id, snapshot_id);
CREATE INDEX IF NOT EXISTS idx_project_snapshot_entries_revision
  ON project_snapshot_entries(resource_revision_id);

CREATE TRIGGER IF NOT EXISTS trg_project_snapshot_entries_approved_only
BEFORE INSERT ON project_snapshot_entries
WHEN (
  SELECT status FROM project_resource_revisions
  WHERE id = NEW.resource_revision_id AND resource_id = NEW.resource_id
) <> 'approved'
BEGIN
  SELECT RAISE(ABORT, 'snapshot entries must reference approved revisions');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_snapshot_entries_no_update
BEFORE UPDATE ON project_snapshot_entries
BEGIN
  SELECT RAISE(ABORT, 'project_snapshot_entries are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_snapshot_entries_no_delete
BEFORE DELETE ON project_snapshot_entries
WHEN (SELECT user_version FROM pragma_user_version) <> 9009
BEGIN
  SELECT RAISE(ABORT, 'project_snapshot_entries are immutable');
END;

CREATE TABLE IF NOT EXISTS project_memory_suggestions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL
    REFERENCES translation_projects(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN (
    'term',
    'proper_noun',
    'character_voice',
    'style_rule',
    'approved_decision',
    'context_note',
    'parallel_excerpt',
    'counterexample'
  )),
  content_json TEXT NOT NULL,
  source_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected')),
  materialized_resource_id TEXT
    ,
  resolved_revision_id TEXT
    ,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  UNIQUE(project_id, idempotency_key),
  FOREIGN KEY(materialized_resource_id, project_id)
    REFERENCES project_resources(id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY(resolved_revision_id, materialized_resource_id)
    REFERENCES project_resource_revisions(id, resource_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_project_memory_suggestions_project_status
  ON project_memory_suggestions(project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_memory_suggestions_resource
  ON project_memory_suggestions(materialized_resource_id, status);
CREATE INDEX IF NOT EXISTS idx_project_memory_suggestions_created
  ON project_memory_suggestions(created_at DESC);

CREATE TABLE IF NOT EXISTS session_project_contexts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE
    REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL
    REFERENCES translation_projects(id) ON DELETE RESTRICT,
  project_snapshot_id TEXT NOT NULL
    ,
  direction TEXT NOT NULL CHECK(direction IN ('en_to_zh','zh_to_en','custom')),
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  resource_revision_ids_json TEXT NOT NULL,
  resources_json TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0 CHECK(token_estimate >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(project_snapshot_id, project_id)
    REFERENCES project_snapshots(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_session_project_contexts_project_created
  ON session_project_contexts(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_project_contexts_snapshot
  ON session_project_contexts(project_snapshot_id);
CREATE INDEX IF NOT EXISTS idx_session_project_contexts_session
  ON session_project_contexts(session_id);
CREATE INDEX IF NOT EXISTS idx_session_project_contexts_direction_created
  ON session_project_contexts(direction, created_at DESC);

-- A session's injected project context is frozen. Deletion remains available
-- only through the owning session's ON DELETE CASCADE for test/reset cleanup.
CREATE TRIGGER IF NOT EXISTS trg_session_project_contexts_no_update
BEFORE UPDATE ON session_project_contexts
BEGIN
  SELECT RAISE(ABORT, 'session_project_contexts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_session_project_contexts_no_delete
BEFORE DELETE ON session_project_contexts
WHEN (SELECT user_version FROM pragma_user_version) <> 9009
  AND EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
BEGIN
  SELECT RAISE(ABORT, 'session_project_contexts are immutable');
END;

-- Operation-level idempotency records compare a canonical request hash before
-- replaying a prior result. A reused key with different semantics is rejected.
CREATE TABLE IF NOT EXISTS project_idempotency_records (
  operation TEXT NOT NULL CHECK(operation IN (
    'project_create',
    'project_archive',
    'resource_create',
    'resource_revision',
    'resource_approve',
    'resource_reject',
    'suggestion_create'
  )),
  owner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(operation, owner_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_project_idempotency_records_created
  ON project_idempotency_records(created_at DESC);
