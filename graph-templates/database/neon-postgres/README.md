# database.neon-postgres.connection

A deterministic connection scaffold for a persistent Node 24 process, using
standard PostgreSQL/TLS transport with pg and Drizzle. Neon supports this
transport; this node no longer emits a WebSocket/edge-runtime driver.

Requires the reviewed project helper markers and explicitly provisioned
pg 8.23.0, drizzle-orm 0.45.3, drizzle-kit 0.31.11 and @types/pg 8.23.1.
Rendering installs nothing and never opens a connection.
The package proposal pins the generation-only @esbuild-kit/core-utils/esbuild
override to 0.25.12 to avoid its old development-server advisory. Conflicting
overrides require reconciliation. Refresh the lock explicitly in the approved
dependency-provisioning workflow, never by executing target install hooks.

Produces database.ts, database-url.ts, an initially empty schema.ts and a
credential-free drizzle.config.ts. Adds DATABASE_URL to the reviewed helper
and dbGenerate to package scripts. Existing divergent helpers, scripts or
generated files require reconciliation; downstream schema additions are not
overwritten. database.migrations separately owns the guarded dbMigrate runner.

DATABASE_URL is the only application target. No NEON_DATABASE_URL alias or
implicit fallback is used. Remote connections verify TLS certificates; URL
query flags cannot disable verification or read local certificate paths.
Only sslmode=require/verify-full are accepted. Numeric loopback may use
plaintext only with NODE_ENV=development/test and GRAPH_DATABASE_ALLOW_LOCAL=1.
Pool size/timeouts are bounded; connection failures are logged generically.
Remote targets require a URL password. A pg password callback blocks implicit
PGPASSWORD/pgpass fallback, including deliberately empty isolated-test passwords.
The generated server must close its exported pool during graceful shutdown.

Validation and runtime evidence live in
packages/engine/tests/template-runtime-database.test.ts: strict compilation,
real offline PostgreSQL operations, target guards and credential redaction.
No hosted Neon connection was tested, and offline PostgreSQL success does not
prove hosted networking, provider settings or production deployment.

Primary references: [Neon Node connections](https://neon.com/docs/guides/node),
[node-postgres TLS](https://node-postgres.com/features/ssl), and
[Drizzle generation](https://orm.drizzle.team/docs/drizzle-kit-generate).
