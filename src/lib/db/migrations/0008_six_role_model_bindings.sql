-- Give the main Agent and every deliberation stage an independent binding.
-- Existing profiles inherit the former main Agent binding so historical
-- behaviour remains stable until the user changes a role explicitly.

ALTER TABLE workspace_model_profiles ADD COLUMN review_agent_json TEXT;
ALTER TABLE workspace_model_profiles ADD COLUMN filter_agent_json TEXT;
ALTER TABLE workspace_model_profiles ADD COLUMN orchestrate_agent_json TEXT;
ALTER TABLE workspace_model_profiles ADD COLUMN assemble_agent_json TEXT;

UPDATE workspace_model_profiles
SET
  review_agent_json = main_agent_json,
  filter_agent_json = main_agent_json,
  orchestrate_agent_json = main_agent_json,
  assemble_agent_json = main_agent_json
WHERE
  review_agent_json IS NULL
  OR filter_agent_json IS NULL
  OR orchestrate_agent_json IS NULL
  OR assemble_agent_json IS NULL;
