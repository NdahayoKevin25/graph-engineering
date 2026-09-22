# Graph Engineering

A local-first engineering platform built on the existing Graph Engineering template ecosystem. Keep project context and reviewed memory on your machine, retrieve source-backed context through MCP, and run bounded coding work in isolated Git worktrees.

```text
repository → syntax graph + SQLite search + optional local embeddings
                         ↓
              context packets + reviewed memory
                         ↓
        policy + deterministic baseline + Laya/Jev shadow decisions
                         ↓
          coding worker → isolated patch → offline container checks
                         ↓
                 optional commit / draft PR into dev
```

## Start

Use Node.js 24 and Git. Docker is required for managed verification, not indexing or retrieval.

```sh
npm ci
npm run build
npm run setup:git
npm run graph -- -C /path/to/your/project init
npm run graph -- -C /path/to/your/project index
npm run graph -- -C /path/to/your/project serve
```

Open the printed loopback URL for the dashboard. Projects default to local-only inference, no external network, no publication, and shadow-mode decisions. No models or credentials are provisioned implicitly.

See the [platform guide](docs/platform.md) for providers, MCP, context, memory, isolated runs, and policy configuration; [decision guide](docs/decisions.md) for Laya/Jev and evaluation; and [installed-worker limits](docs/installed-workers.md) for native client capabilities.

## Repository

| Area                 | Purpose                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `packages/contracts` | Versioned project, context, execution, and decision contracts                   |
| `packages/engine`    | Local SQLite context engine, CLI, MCP, authenticated loopback API, managed runs |
| `packages/dashboard` | React context, graph, memory, run, and decision interfaces                      |
| `sidecars/laya`      | Explicitly provisioned, offline-serving decision sidecar                        |
| `evaluation`         | 60 synthetic fixtures and a measured baseline/candidate runner                  |
| `create-graph-app`   | Existing coarse-grained app scaffolder and six working templates                |
| `graph-templates`    | Fine-grained node contracts, schemas, examples, and artifact validation         |
| `reference-app`      | Source application behind the original templates                                |

The two template systems intentionally retain their different schemas. Existing scaffolding remains usable independently; see [create-graph-app](create-graph-app/README.md), [graph templates](graph-templates/README.md), and the [reference architecture](REFERENCE_ARCHITECTURE.md).

## Checks and collaboration

```sh
npm run check
npm ci --prefix graph-templates/tools/validate-graph
npm test --prefix graph-templates/tools/validate-graph
GRAPH_ENGINE_DOCKER_TESTS=1 npm test -w @graph-engineering/engine
```

Use focused feature branches, reviewed PRs, and `dev` as the integration branch. Never push to `main`; commits use the human Git identity without AI co-author trailers. See [contributing](CONTRIBUTING.md). Release publishing is separate from normal development; the [CLI release guide](docs/publishing-cli.md) is reference material, not an automated publishing step.

## Current boundaries

The graph is syntax-backed, not a complete semantic call graph. Missing language resolution and unavailable embeddings are reported. Local storage does not make a cloud-backed coding client offline: cloud export requires explicit policy and source-path permission. Laya/Jev scores do not prove code correct; verification and human PR review remain independent. No token-savings or engineering-accuracy claims are made without measured evaluation results.

The [evaluation corpus](evaluation/README.md) is a reproducible synthetic smoke suite, not evidence that routing is ready for autonomous architecture or security decisions. Promotion remains disabled until separately collected calibration and held-out results meet the documented gates.
