# Reviewed migrations

Generate SQL and metadata offline with npm --ignore-scripts run dbGenerate in
an approved sandbox. Review and commit them together. The Drizzle config has
no database credentials, so generation is not permission to connect.

Compile in the sandbox, then use npm --ignore-scripts run dbMigrate only after
explicit approval. Required environment: MIGRATION_DATABASE_URL,
GRAPH_DATABASE_EXPECTED_NAME, NODE_ENV, and
GRAPH_DATABASE_MIGRATE=reviewed-migration. Application DATABASE_URL is not used.
A GitHub protected-environment reference alone does not prove review protection.

Do not edit applied SQL or journal metadata. The runner verifies applied hashes
and chronological timestamps, refuses concurrent guarded operations, and
applies pending migrations transactionally. An SQL failure rolls back that
transaction; generic logs omit SQL, credentials and raw driver errors.

Rollback here means failed transaction rollback, not automatic undo of a
committed migration. There is no dbRollback/down command. Use an independently
reviewed forward fix or restore plan and verify backups before destructive work.
