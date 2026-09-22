# Dashboard browser checks

Build the workspace (`npm run build` at the repository root), then install the
browser with `npx playwright install chromium` from `packages/dashboard`.
On Linux CI use `npx playwright install --with-deps chromium`.

From the repository root:

```sh
npm run test:e2e:fixture -w @graph-engineering/dashboard
```

The launcher starts the real built engine on an ephemeral loopback port. It
creates source, memory, and storage only in one temporary directory, passes the
generated access token privately to the test process, and removes the temporary
directory on success or failure. No worker or model runs; no Docker is required.
The fixture covers both desktop and mobile, retrieval, graph traversal, memory
acceptance/sharing, and deterministic plan creation. It never edits the working
project, accesses its persisted memories, or changes provider credentials.

To inspect an already running engine instead, set `GRAPH_E2E_TOKEN` to the token
from its terminal URL and optionally `GRAPH_E2E_URL`, `GRAPH_E2E_QUERY`, and
`GRAPH_E2E_SYMBOL`; run `npx playwright test`. The memory-writing fixture checks
are skipped unless the fixture launcher explicitly enables them. Live checks
only read the project and perform context retrieval (which can refresh its index).

Screenshots and failure traces are local ignored artifacts in `test-results/`.
Traces can contain retrieved source and the ephemeral local connection token;
do not publish artifacts from private live projects.
