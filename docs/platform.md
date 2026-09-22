# Graph Engineering platform

The platform extends the existing template registry with a local context engine and managed engineering runs. The CLI, MCP server, and browser dashboard use the same project configuration and local database. The template systems keep their separate metadata contracts.

## Start locally

Use Node.js 24, Git, and npm. Managed builds and tests additionally need a running Docker-compatible engine. Normal indexing and context retrieval do not require containers or cloud credentials.

```sh
npm ci
npm run build
npm run setup:git
npm run graph -- -C /path/to/project init
npm run graph -- -C /path/to/project index
npm run graph -- -C /path/to/project context 'Where is authentication handled?'
npm run graph -- -C /path/to/project serve
```

Open the printed loopback URL. Its fragment contains a local access token, which the dashboard stores only in the browser session. The server rejects unauthenticated API requests, non-loopback hostnames, and cross-origin requests. It is not a remotely exposed team service.

`.graph/project.json` is shared project configuration. Private data lives in the platform-specific user data directory under `graph-engineering/projects/<projectId>`; `GRAPH_ENGINE_DATA_DIR` can choose another root. Project IDs are stable across the partners' clones, while worktree and dirty-content identities keep source snapshots distinct.

## Context and memory

TypeScript/JavaScript, Python, Go, Rust, Java, and C# have bundled Tree-sitter grammars. Declarations, imports, and call expressions are indexed with explicit evidence. Dynamic dispatch and unresolved imports remain unresolved. Other text is searchable without claiming semantic language coverage.

SQLite stores revisioned records, FTS search, graph edges, and optional semantic vectors. Native database operations run in a dedicated worker thread. Ignored files, symlinks outside the project, excluded paths, credential patterns, and oversized/binary files are omitted. Omitted coverage is reported. Source hashes invalidate parsing and embedding caches; mandatory constraints cannot be silently dropped from context packets.

Semantic retrieval uses pinned local Jina code embeddings. Weights are an explicit download of approximately 642 MB; ordinary startup/index/search never downloads them. Use `embeddings-provision` only after allowing the documented model distribution hosts in project network policy. Indexing and lexical retrieval work without weights, and report semantic search as unavailable.

```sh
npm run graph -- -C /path/to/project memory-add 'Preserve the existing public API' --kind constraint
npm run graph -- -C /path/to/project memories
npm run graph -- -C /path/to/project memory-accept MEMORY_ID
npm run graph -- -C /path/to/project memory-share MEMORY_ID
```

New memories are private proposals. Acceptance makes a record usable as project knowledge; sharing writes a reviewable `.graph/knowledge/<id>.json` file without committing it. Supersession keeps history. Contradictions remain visible. Private mandatory memories block cloud context export rather than disappearing from a task.

## MCP clients

Configure the installed CLI as a stdio MCP server:

```json
{
  "command": "node",
  "args": [
    "/absolute/path/to/graph-engineering/packages/engine/dist/cli.js",
    "-C",
    "/path/to/project",
    "mcp",
    "--client",
    "cloud"
  ]
}
```

Use `--client local` only for a consumer whose inference actually stays local. Cloud-backed clients are refused for offline projects. MCP exposes context, symbols, graph relationships, templates, memory proposals, and run status. `--allow-run` separately enables starting existing managed plans. MCP does not replace a native client's own permissions or intercept all its model calls.

## Configure workers

Providers are machine-local configuration, while the project policy determines which providers and source paths are allowed. Credentials are read from named environment variables and are never stored in project configuration.

```sh
npm run graph -- -C /path/to/project provider-add qwen local YOUR_LOCAL_MODEL --endpoint http://127.0.0.1:11434/v1 --enable
npm run graph -- -C /path/to/project check-add node:24-alpine node --test test.cjs
npm run graph -- -C /path/to/project plan 'Fix the failing addition test' --accept 'The addition test passes' --provider qwen
npm run graph -- -C /path/to/project run PLAN_ID
```

The local endpoint must support OpenAI-compatible chat completions and structured JSON responses. Graph Engineering does not install or assume a particular generative model. Cloud API providers use `openai` or `anthropic`; configure their model, supported efforts, and credential environment variable explicitly. Installed-agent capability restrictions are described in `installed-workers.md`.

To enable cloud access, review `.graph/project.json`: set inference/network to `allowlisted`, add permitted provider IDs and exact HTTPS hosts, and list exportable file patterns. Local-only remains the default. Do not use wildcard network hosts. A strict cost budget requires known pricing and a compatible API worker; missing telemetry is unknown, not zero.

Cost-capped projects abstain from hosted Jev routing because this adapter cannot meter that service's spend; local decisions and deterministic defaults remain available. Budgets use conservative configured-price estimates, not provider billing guarantees.

The worker proposes exact-substring patches or asks for specific missing files. The engine validates the entire proposal before editing its isolated worktree. Original files remain untouched. Verification runs against a separate source view in a provisioned container with no external network, credentials, repository metadata, or private configuration mounted. Verification inputs must remain unchanged during checks. Preload dependencies into the verification image when a build needs them; the engine never silently installs packages from the network.

Verification resolves local image tags to immutable image IDs and records that identity. Detailed failure excerpts stay local; cloud/native workers receive generic check-failure feedback because logs may contain non-exportable source. They may request additional explicitly exportable files. This trades some debugging convenience for an enforceable export boundary.

Runs preserve structured events and failures. A changed policy or source snapshot invalidates dispatch. Cancellation stops further work. After a crash or failed attempt, inspect the retained worktree and events before `resume RUN_ID --reconciled`; ambiguous external effects are never blindly repeated.

## Publication

Publication defaults to `none`. To enable it, choose `commit` or `draft-pr` and configure a GitHub repository, remote, and `dev` base branch. Git and `gh` use the user's supported local authentication. The original worktree must be clean before a publishing run so unrelated edits cannot enter its commit. Draft PRs require explicit GitHub network permission. Main/master push and PR targets are rejected. Merging and publishing releases remain human actions.

Managed Git operations suppress repository hooks, executable filters, filesystem monitors, and signing programs. Publication verifies the actual staged bytes against the checked source. Files requiring Git LFS/custom clean filters or checkout normalization may need manual publication; the engine fails closed instead of committing bytes different from those verified. Interrupted publication reconciles run-owned commits and existing PRs after explicit review and reverification.

## Validation and platform support

```sh
npm run check
npm ci --prefix graph-templates/tools/validate-graph
npm test --prefix graph-templates/tools/validate-graph
GRAPH_ENGINE_DOCKER_TESTS=1 npm test -w @graph-engineering/engine
```

The launch target matrix is macOS ARM64, Linux x64/ARM64 on glibc, and Windows x64. CI checks native dependencies and all language parsers on those runners. The optional embedding integration test downloads real weights; default tests remain offline. Existing generated-app builds have their own opt-in smoke check.

Runner labels follow GitHub's [hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners); the configured `macos-15` runner is ARM64.

Decision-model promotion requires labeled, disjoint calibration/held-out evidence and end-to-end outcomes. The repository does not ship fabricated success-rate or token-savings claims. See `decisions.md` for running Laya/Jev and evaluating actual outcomes.

## Template adapters and bounded decisions

`templates` lists separate `scaffold:` and `graph-node:` namespaces. `scaffold CONFIG TARGET` previews the existing coarse-grained generator; add `--write` to materialize it without automatic dependency installation. `validate-graph ARTIFACT_DIRECTORY` checks fine-grained graph schemas, implemented-node status, distinct invocation IDs, dependency bindings, order, cycles, manifests, and required artifact coverage. Fine-grained template prompts remain agent-consumed contracts; this version does not pretend that every prompt-based node is a deterministic code generator.

Managed planning records worker, workflow, supported effort, and context-budget decisions. Shadow predictions do not change the deterministic plan. Promoted choices must remain in the policy-allowed candidate set; explicit worker/effort selections take precedence. No classifier can disable required checks, approve a merge, or expand file/network permissions. Routing quality and reduced retry cost must be evaluated together before enabling autonomy.
