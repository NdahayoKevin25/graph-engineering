# devops.docker

Deterministically proposes a Node 24 multi-stage Dockerfile, minimal build-context
allowlist, and loopback-bound Compose service. Rendering reads validated target
configuration but never executes target scripts on the host.

Requires a single-package TypeScript application with `src/app.ts`, a
`src` → `dist` tsconfig, an explicit build script, and a v2/v3 package lock matching
declared dependencies. Inputs: `nodeVersion: "24"` and nonprivileged `port`
1024–65535 (default 3000). Unsupported inputs fail closed. Existing custom files
are not overwritten; identical output is idempotent.

The build stage uses `npm ci --ignore-scripts` and suppresses pre/post-build hooks.
A separate stage prunes development dependencies without install hooks. The
default Debian-slim runtime receives only production dependencies, package.json
and compiled dist, runs as the nonroot node user, and launches `dist/app.js`.
Dependencies requiring installation scripts need explicit review/provisioning;
this renderer does not silently enable those hooks.

The build context excludes all `.env*` casing variants, Git/private graph data,
private-key files, npm/netrc credentials, node_modules and unlisted paths.
Compose injects a separately supplied ignored `.env` at runtime; it never enters
the image. Compose uses read-only rootfs, a bounded /tmp tmpfs, dropped
capabilities and no-new-privileges. It binds the selected port to 127.0.0.1 and
does not start a database service.

`NODE_BUILD_IMAGE` and `NODE_RUNTIME_IMAGE` build arguments default to
`node:24-bookworm-slim`. Explicit overrides must be reviewed Node 24 images;
a tag is not an immutable supply-chain guarantee. Tests use a preprovisioned
Node 24 dependency-cache image for the build stage and the actual slim runtime,
with `NPM_CONFIG_OFFLINE=true`, `--pull=false` and `--network=none`.
No image or dependency provisioning happens during rendering.

Validate generated output in an explicitly approved isolated Docker build/run,
never by running target npm scripts on the host. The engine regression suite
checks an actual offline image build, excluded private files, disabled hooks,
nonroot startup and the minimal runtime. It does not validate deployment
credentials, external database connectivity, or production image approval.
