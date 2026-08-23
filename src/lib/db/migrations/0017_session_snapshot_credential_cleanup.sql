-- Historical config_snapshot credentials are removed by migrate.ts inside the
-- same transaction that records version 17. SQL remains intentionally inert so
-- source and packaged migration trees share one versioned artifact.
SELECT 1;
