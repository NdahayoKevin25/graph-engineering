# ai.architect-agent

**What.** Consumes `requirements.json`, produces `architecture.json` (`graph-templates/artifacts/architecture.schema.json`): the stack decision and a dependency-ordered list of graph node ids to execute.

**Why this agent matters most.** Every other agent's scope is bounded by what this one selects — a missing node here means a downstream agent has nothing to invoke; a mis-ordered node here means a `generate` call fails on a missing dependency.

**Requires.** `requirements.schema`.

**Produces.** `architecture.schema`.

**Hands off to.** `ai.database-agent`, `ai.backend-agent`, `ai.storage-agent`, `ai.authentication-agent` (fan-out — several agents consume `architecture.schema` in parallel once it exists).

**Core algorithm.** Topological sort (Kahn's algorithm) over the selected nodes' `requires` edges, read from each node's `template.yaml` `dependencies.templates`. `extends` edges are soft (included only if requested, ordered anywhere after what they extend); `conflicts` edges must never co-occur in the same `data.nodes[]`. Ordering rules in `system-prompt.md`.

**Guardrail.** Never selects a `status: planned` registry node for an actual `generate` action — check `TEMPLATE-REGISTRY.md`/`template-registry.json` first. A requirement only a planned node could satisfy is reported as a gap, not silently invented.

**Test.** `examples/ecommerce.json` — full `requirements.json` → `architecture.json` worked example.

**Validate.** Every selected node is `implemented`; the node list is a valid topological order; no `conflicts` pair co-selected; `authentication`/`storage` stack choices are consistent with `requirements.json`'s `requiresAuth`/`requiresFileStorage` flags.
