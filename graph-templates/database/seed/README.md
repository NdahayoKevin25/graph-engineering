# database.seed

Generates a standalone compiled seed runner and package script. It does not
connect, build, install packages or insert data during rendering.

Input entities contain entityName, tableExportName and sampleRows. Values must
be plain JSON: no functions, expressions, prototypes, secret-shaped strings or
executable identifiers. Limits: 20 entities, 100 rows/entity, 50 properties per
object, 100 items/JSON array, 2,048 characters/string, 64 KiB total and ten total
nesting levels including metadata. Identifiers must match literal exported
pgTable definitions; unknown fields, omitted required fields, duplicate rows
and unsupported column/value types fail closed. Generated timestamps should
be omitted. JSON is serialized as data, never evaluated.

Exact repeats are generation no-ops. New entities may be added to an unchanged,
renderer-owned seed file. Existing entities with differing rows, edited source,
duplicate table mappings or conflicting package scripts require reconciliation;
nothing is silently overwritten. Sample data must be invented fixtures, not PII.

Execution requires all of:

- SEED_DATABASE_URL; DATABASE_URL is never a fallback.
- Numeric loopback host 127.0.0.1 or ::1; remote seeds are intentionally unsupported.
- A database name ending _test, _seed or _dev and an exact
  GRAPH_DATABASE_EXPECTED_NAME match.
- NODE_ENV=development/test and GRAPH_DATABASE_SEED=isolated-seed-database.
- GRAPH_DATABASE_ALLOW_LOCAL=1 if the isolated server uses plaintext.

Name/environment declarations cannot prove that a database is disposable:
the operator must provision a dedicated isolated database and review the target.
Compile in an approved sandbox, then npm --ignore-scripts run seed.

All entities insert in one transaction under an advisory lock and table locks.
Nonempty tables are refused, including a previously successful seed; there is
no implicit upsert, truncation, overwrite or duplicate rerun. If a later entity
fails, earlier inserts roll back. Logs omit fixture rows, SQL and raw errors.
Offline PostgreSQL evidence is documented in docs/database-runtime.md.
