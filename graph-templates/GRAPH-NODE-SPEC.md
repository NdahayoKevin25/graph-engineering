# Graph Node Contract

Every template in `graph-templates/` is a **graph node**: a self-contained, machine-readable unit an orchestration agent can discover, select, configure, execute, and validate without reading its implementation first. This document defines the contract every node must satisfy. The concrete schema for a node's `template.yaml` is in `TEMPLATE-SPEC.md`; this document defines the *conceptual* contract that schema encodes.

## 1. Identity

Every node has a globally unique, dotted `id` that mirrors its path under `graph-templates/`:

```
<category>.<subcategory>.<name>
storage.aws-s3.upload
backend.express.controller
database.neon-postgres.connection
```

Plus `name` (human-readable), `version` (semver — see `TEMPLATE-SPEC.md` §Versioning), `category`/`subcategory`, and `status` (`implemented` | `planned` | `experimental`).

The registry `id` identifies a reusable template, not an execution. Architecture artifacts at version `2.0.0` assign each invocation a unique `instanceId` (for example `api.crud:Project` and `api.crud:Invoice`, both with `id: api.crud`). Singleton invocations conventionally use their template ID as `instanceId`. Edges, manifests, and execution state key on invocation identity; registry lookup and template compatibility continue to use `id`. When a prerequisite template is instantiated more than once, `bindings` maps its template ID to the chosen upstream instance ID. See `ARTIFACT-SPEC.md` §7.

## 2. Inputs

The typed, named values a node needs to configure its output. Inputs come from three places, in priority order: (1) explicit values an agent passes when invoking the node, (2) values read from an **artifact** the node consumes (§6), (3) the input's declared `default`. A required input with no value from any of the three sources is a hard error — the node must not guess.

```json
{ "entity": "Product", "fields": [{ "name": "price", "type": "numeric" }] }
```

## 3. Outputs

What executing the node produces, typed the same way as inputs. Outputs are how downstream nodes and artifacts learn what happened — an orchestrator should never need to re-read generated source to know, e.g., which routes a node registered.

```json
{ "files": ["src/routes/productRoutes.ts"], "routes": ["/api/products"], "databaseTables": [] }
```

## 4. Dependencies

What must already exist before the node can execute, in three tiers:

- **Packages** — npm packages the generated code imports (with version ranges).
- **Services** — external services the code assumes are reachable at runtime (`postgres`, `s3-compatible-storage`) — not installed by the node, just declared as an operating assumption.
- **Templates** — other graph nodes, each tagged `requires` (must have run first), `extends` (optional, adds to it if present), or `conflicts` (mutually exclusive — e.g. two different ORM nodes on the same project).

A node must declare every template it structurally depends on. An orchestrator resolves the dependency graph before execution; it is an error to execute a node whose `requires` templates have not run.

## 5. Compatible nodes

`compatible_with.upstream` / `compatible_with.downstream` name nodes that commonly precede/follow this one in a graph — this is advisory (for graph *composition* and suggestion), distinct from `dependencies.templates` (which is a hard requirement). A node can be compatible with something it doesn't require (e.g. `backend.express.controller` is downstream-compatible with several different database nodes without requiring any specific one).

## 6. Artifacts (structured handoff)

Nodes exchange state through versioned JSON artifacts (schemas in `graph-templates/artifacts/`), not natural language. A node declares `consumes` (artifacts it reads to fill inputs) and `produces` (artifacts it writes or updates after executing). See `ARTIFACT-SPEC.md`.

## 7. Actions

Every node supports a subset of:

| Action     | Meaning                                                                 |
|------------|--------------------------------------------------------------------------|
| `generate` | First-time creation. Must be safe to call on an empty project.          |
| `detect`   | Read-only: report whether this node's output already exists, and its current config. |
| `modify`   | Change an existing installation of this node (e.g. add a field to a generated entity). |
| `validate` | Read-only: run this node's `validation.checks` against the current project state. |
| `test`     | Run this node's `tests/`. |
| `repair`   | Attempt to fix a `validate` failure automatically. |
| `delete`   | Remove what this node generated, where safe/reversible. |

A node's `template.yaml` declares which of these it supports — not every node supports `delete` or `repair`.

## 8. Idempotency

`generate` must be safe to invoke more than once (§ Idempotency, `TEMPLATE-SPEC.md`). Before creating a file, a node's tooling runs `detect` implicitly; if the target already exists, it falls back to the node's declared `idempotency.strategy` rather than overwriting.

## 9. Validation

A node is not "done executing" until its `validation.checks` pass. Checks are declarative (file-exists, TypeScript compiles, a named export exists, a migration applies cleanly) so the **Validation Agent** (`ai/validation-agent/`) can run them mechanically across an entire generated graph, not just introspect one node.

## 10. Non-goals

A node's contract says nothing about *how* an agent decides to use it — that's the orchestrator/agent's job, informed by `TEMPLATE-REGISTRY.md`. The contract only guarantees that once selected, a node is predictable: same inputs (+ same pre-existing project state) → same declared outputs, checkable by the same validation.
