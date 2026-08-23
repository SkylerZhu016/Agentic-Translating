-- Persist the Main Agent drafting mode with each direction-scoped workspace
-- draft. Historical rows retain the stable fixed workflow by default.

ALTER TABLE workspace_drafts
  ADD COLUMN main_editor_run_mode TEXT NOT NULL DEFAULT 'fixed_pipeline'
    CHECK(main_editor_run_mode IN ('fixed_pipeline', 'tool_enabled'));
