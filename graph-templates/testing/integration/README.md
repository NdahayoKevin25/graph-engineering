# testing.integration

Generates `tests/setup/testDatabase.ts` and guard tests. The helper uses `pg`
and `drizzle-orm/node-postgres`, so an ordinary disposable PostgreSQL database
works without a Neon WebSocket proxy. Declare `pg`, its TypeScript types,
Drizzle, and Vitest explicitly; the runtime does not install dependencies.

Exports: `getTestDatabase()`, `truncateAllTables(tableNames)`, and
`closeTestDatabase()`. Close the pool in suite teardown. Changing its URL while
the pool is open fails rather than silently reusing the previous connection.

Both connecting and cleanup require `NODE_ENV=test` and an explicit
`TEST_DATABASE_URL` naming a database ending in `_test`. There is **no**
`DATABASE_URL` fallback. A matching application URL target is rejected even
when credentials differ. URL driver overrides, certificate filesystem paths,
and duplicate query options are forbidden; test TLS supports `verify-full`,
or `disable` for an isolated local test database.

Cleanup is destructive and additionally requires
`GRAPH_TEST_DATABASE_ALLOW_TRUNCATE=1`. It validates all identifiers before
connecting, then truncates only the listed `public` tables in one atomic
statement with identity reset. There is no `CASCADE`: unlisted foreign-key
dependents make cleanup fail rather than losing their rows.

Database names and URL comparisons are defense in depth, **not proof of
isolation**: aliases can resolve to the same server. Provision a disposable
database and a role without production privileges. Never point this helper at
valuable data, even if it happens to have a `_test` suffix.

`npm test -- testDatabase` runs the no-connection guard tests. The platform's
separate Docker suite also exercises real PostgreSQL, strict TypeScript,
foreign-key failure atomicity, selected-table cleanup, and preservation of an
unlisted table. PostgreSQL and tests run inside one network-disabled container;
the suite never uses the host's database or credentials.
