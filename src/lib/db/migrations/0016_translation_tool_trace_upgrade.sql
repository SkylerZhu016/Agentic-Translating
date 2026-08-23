-- 0016_translation_tool_trace_upgrade.sql
-- Upgrade deployed migration-15 tool traces with replay/provider linkage.
--
-- migrate.ts probes and adds the nullable provider_tool_call_id and
-- logical_call_key columns, then creates the associated indexes inside the
-- same migration transaction. SQLite has no ADD COLUMN IF NOT EXISTS, so the
-- probe keeps historical v15 and development-v15 databases equally safe.
-- Keep this SQL marker free of references to the new columns: a few legacy
-- offline schema readers execute migration resources directly without the
-- application migrator, and must be able to inspect the complete resource set.

SELECT 1;
