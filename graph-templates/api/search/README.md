# api.search

This audited renderer adds genuine PostgreSQL English full-text search for one
existing reviewed Drizzle `pgTable` with an explicit UUID primary key. It is not the exact-match filtering in
`api.crud`, and it does not implement trigram fuzziness, multi-table search,
highlighting, or arbitrary client-selected sorting. One invocation creates a
typed `search<Entity>` function, a bounded query parser, emitted tests and an
`authMiddleware`-gated `GET /api/search/<table>` route. Results contain ranked IDs and
`{ page, pageSize, total }`; rank descending and UUID ascending break ties.

Inputs are `entityName`, `tableName`, and 1–4 unique `searchFields`. The fields
must be actual text/varchar columns on the literal exported table; the renderer
checks the TypeScript AST and refuses dynamic/custom table declarations or an
existing divergent index callback. The generated SQL has only reviewed SQL
identifiers. Query text, page size and offset are PostgreSQL bound parameters.
The parser allows 2–160 query characters, at most 256 UTF-8 bytes and 12 words;
page is at most 1000 and page size at most 50. Arrays, nested query objects,
controls and extra keys are rejected.

The source modifies `src/config/schema.ts` with a GIN expression index using
the same `to_tsvector('english', coalesce(...))` expression as the query. This
is **not** an applied index. Run the existing offline `dbGenerate` step, review
its SQL, and apply via the separately guarded `database.migrations` workflow
with an operator-approved target. Rendering never contacts PostgreSQL, installs
packages, or applies DDL. Generating an index on a populated production table
may require a separately planned, nontransactional concurrent-index migration;
the default guarded transactional migration path must not silently switch to
that operation.

The route always mounts `authMiddleware` before querying; the application must
ensure that prerequisite actually enforces authentication. Authentication alone
is not row-level or tenant authorization: the generated search function scans
all matching rows in its table. Do not use this node on sensitive or
tenant-scoped data without a separately reviewed predicate and tests. The
renderer mounts the search route before the scaffold's other application routes
and rejects unreviewed earlier app registrations, so a prior handler cannot
shadow its authentication check. It refuses user-owned conflicting outputs and requires exact pinned
`pg`, Drizzle and Express declarations. The generated route uses the existing
`asyncHandler` and `APIError` contracts.

The renderer also changes only the reviewed scaffold's Morgan `dev` logger:
it skips the exact `/api/search` path and the `/api/search/` path prefix before
Morgan can emit a URL, including unauthenticated and unmatched-method requests.
The slash delimiter does not suppress similarly named paths such as
`/api/searching`. Percent-encoded namespace spellings such as
`/api%2Fsearch/products` are outside this guard and may be logged when they do
not match the generated route. Other app, proxy, CDN, tracing and database
logs may still record query text; assess those separately before sending
sensitive terms.
