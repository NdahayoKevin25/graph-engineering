# database.migrations

Generates src/scripts/migrate.ts, migration-directory documentation and the
dbMigrate package script. It is executable source generation, not merely a
README-presence check. Rendering never runs migrations or target scripts.

The companion connection node owns offline dbGenerate. Compile the source in
an approved sandbox before invoking dbMigrate; it executes
node dist/scripts/migrate.js, not an unreviewed install/build hook.

Application DATABASE_URL is never a migration fallback. Execution requires:

- MIGRATION_DATABASE_URL for the reviewed target.
- GRAPH_DATABASE_EXPECTED_NAME matching that URL's database exactly.
- Explicit NODE_ENV=development, test or production.
- GRAPH_DATABASE_MIGRATE=reviewed-migration.
- Verified TLS, except explicitly enabled numeric-loopback development/test.

These are operator declarations, not proof of human approval or correct remote
database classification. Production runs require separately verified access,
protected-environment review and a backup/recovery plan.

The runner holds a session advisory lock, validates stored migration hashes and
timestamps against the local chronological history, and delegates pending SQL
to Drizzle's PostgreSQL transaction. Concurrent guarded operations fail closed.
Never edit applied migration SQL or metadata; hash drift is rejected.

Offline evidence includes actual generated SQL, successful apply, repeated
no-op apply, a deliberately failing migration whose earlier CREATE TABLE rolls
back, unchanged migration history on failure, and unchanged-schema generation
producing no extra SQL. This proves failure rollback, NOT reversible migrations:
there is no generated down command, automatic inverse SQL or backup restoration.
Undoing a committed migration needs a separately reviewed forward fix or
restore plan. Some PostgreSQL operations cannot run in a transaction and need
their own reviewed workflow; this runner does not bypass transaction safety.

Run the opt-in engine test only after provisioning its image as described in
docs/database-runtime.md. No host database commands or cloud calls are needed.
