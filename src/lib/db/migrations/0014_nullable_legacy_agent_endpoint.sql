-- Preserve legacy user Agent definitions when an endpoint is removed.
-- An unbound Agent remains editable and can be rebound later; endpoint
-- deletion must never require deleting its name, prompt, model, or ordering.

CREATE TABLE translator_agents_v0014 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  endpoint_id INTEGER REFERENCES endpoints(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  prompt_override TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO translator_agents_v0014 (
  id, name, endpoint_id, model, prompt_override, sort_order, created_at
)
SELECT
  id, name, endpoint_id, model, prompt_override, sort_order, created_at
FROM translator_agents;

DROP TABLE translator_agents;
ALTER TABLE translator_agents_v0014 RENAME TO translator_agents;

CREATE INDEX idx_translator_agents_endpoint_sort
  ON translator_agents(endpoint_id, sort_order, id);
