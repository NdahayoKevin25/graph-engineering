# project.node-express

## Audited executable renderer

The deterministic engine renderer creates a Node 24 TypeScript/Express scaffold,
exact dependency declarations, health/security tests and a public-only generation
ledger. It never installs packages, runs hooks, reads an environment file, or starts
the app while rendering. A lockfile must be provisioned and reviewed separately.
The offline verification fixture has a committed lockfile matching all emitted
dependency versions; it compiles both source and tests, runs 17 generated checks,
and starts the compiled server in an unprivileged, network-disabled container.

Inputs are bounded data: JSON description text is encoded as a JSON value, never
source. CORS accepts at most 16 distinct HTTPS origins, or explicit HTTP loopback
development origins, with no credentials/path/query/fragment or wildcard. Runtime
PORT, NODE_ENV and CORS configuration fail closed with value-free diagnostics.
The rendered fallback returns generic error messages and request logs contain only
method/status/timing, never request URLs, headers, bodies, error objects or stacks.
Downstream backend/auth renderers recognize these exact reviewed scaffold variants.

At the repository root, owners must explicitly enable `allowPublicTemplateLedger`
and permit only the public `.env.example` through their policy exclusions. See
[public artifact policy](../../../docs/public-template-artifacts.md). The example
contains blank names only; set values privately or leave optional variables unset.
The generation ledger is deterministic, does not invent timestamps, and is not
proof of execution, approval or downstream ledger maintenance. Different existing
source is preserved and requires an explicit modification/reconciliation plan.

The asset descriptions below describe the catalog scaffold; the reviewed runtime
adds the validation/logging/error boundaries above instead of interpolating raw
user text into source or executing manifest operations.

**What it does.** Scaffolds a TypeScript Express project: `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, the Express entrypoint (`src/app.ts`) with `cors`/`helmet`/`morgan`/`cookie-parser`, a health-check route, a 404 handler, and the fail-fast `SECRETS` env-validation convention (`src/utils/helpers.ts`) — all lifted directly from the reference app.

**When to use it.** First node in every graph that targets this stack — every other node in `backend/`, `database/`, `storage/`, `authentication/` modifies files this node creates (`src/app.ts`'s middleware list, `src/utils/helpers.ts`'s `SECRETS` shape).

**Requires.** Nothing — this is the root node.

**Produces.** `files` (see `template.yaml`), `entrypoint: src/app.ts`. Initializes the public `.graph/manifest.json` declaration ledger. Runtime invocation manifests are retained independently by the engine.

**Depends on.** `express`, `cors`, `helmet`, `morgan`, `cookie-parser`, `dotenv` + their `@types` and a TypeScript/ts-node/nodemon dev toolchain.

**Connects to.** Downstream: `database.neon-postgres.connection` (imports into `app.ts` indirectly via route mounting), `storage.aws-s3`, `authentication.jwt`, `backend.middleware`. No upstream — always first.

**Configure via.** `inputs.schema.json` — `projectName` (required), `description`, `port` (default 3000), `corsOrigin` (default `http://localhost:3000`).

**Test.** `npm test -- health-check` — asserts `GET /` returns `{ status: 'OK' }`.

**Validate.** `npm run build` must succeed; `package.json` and `src/app.ts` must exist.

**Security.** `helmet()` is mandatory baseline — do not strip it. `CORS_ORIGIN` must stay an explicit allowlist once any node sets `credentials: true` (the JWT cookie node depends on this — a wildcard origin with credentials is rejected by browsers anyway, but never widen it manually).

**On failure.** Use Node 24 or a supported newer version below 27, review the pinned dependency declarations, and provision a matching lockfile before `npm ci`. No install runs automatically. If compilation fails for an unchanged scaffold, retain the actual output and report the template defect rather than bypassing verification.

**Modification.** Other nodes extend `src/app.ts` via the `insert-import` / `insert-before-marker` file operations at the markers `// Import routes`, `// Routes`, and `// Error handling middleware` (present verbatim in `files/src/app.ts.template`) — never regenerate this file after other nodes have modified it; only `modify`.
