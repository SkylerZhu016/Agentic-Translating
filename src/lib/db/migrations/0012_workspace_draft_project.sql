-- Persist the project selected for each direction-scoped workspace draft.
-- Existing draft rows keep NULL so upgrading never invents a project binding.

ALTER TABLE workspace_drafts
  ADD COLUMN selected_project_id TEXT DEFAULT NULL
    REFERENCES translation_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_drafts_selected_project
  ON workspace_drafts(selected_project_id);
