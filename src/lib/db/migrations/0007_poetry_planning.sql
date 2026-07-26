-- Poetry-specialist settings are draft-scoped before submission and frozen
-- into the existing v3 session snapshot after creation.

ALTER TABLE workspace_drafts
  ADD COLUMN constraints_json TEXT NOT NULL DEFAULT '{}';
