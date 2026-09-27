# ai/ — orchestration agent definitions

Meta-level AI agents that drive `graph-templates/`'s code-generation nodes (`backend/`, `database/`, `storage/`, etc.) through the pipeline: `requirements.json → architecture.json → database.schema.json → {api,auth,storage}.schema.json → frontend.schema.json → test.schema.json → deployment.schema.json`, per `ARTIFACT-SPEC.md` §3. See `GRAPH-NODE-SPEC.md` for how these agents relate to the code-generating graph nodes they invoke, and `REFERENCE_ARCHITECTURE.md` for the conventions they enforce.

A full multi-agent runtime orchestrator (`ai.orchestrator`, below) is **out of scope for this template-library deliverable** — it's meant to be implemented by whatever system consumes this registry (e.g. Claude Code itself, following `GRAPH-NODE-SPEC.md`'s node contract), not shipped as a static artifact the way code-generation nodes are.

## Flagship agents (full treatment: README, agent.yaml, system-prompt.md, input/output-schema.json, tools.json, validation.md, examples/)

| Agent | Consumes | Produces |
|---|---|---|
| [`ai.requirements-agent`](requirements-agent/) | — | `requirements.schema` |
| [`ai.architect-agent`](architect-agent/) | `requirements.schema` | `architecture.schema` |
| [`ai.database-agent`](database-agent/) | `requirements.schema`, `architecture.schema` | `database.schema` |
| [`ai.backend-agent`](backend-agent/) | `database.schema`, `architecture.schema` | `api.schema` |
| [`ai.storage-agent`](storage-agent/) | `requirements.schema` | `storage.schema` |
| [`ai.frontend-agent`](frontend-agent/) | `architecture.schema`, `api.schema`, `auth.schema` | `frontend.schema` (+ invokes the selected Next.js or Vite React root/client pair and supported feature nodes) |
| [`ai.testing-agent`](testing-agent/) | `architecture.schema` | `test.schema` |
| [`ai.validation-agent`](validation-agent/) | all artifacts + project files | `{ valid, errors, warnings, repairs }` |

Promoted from the narrower tier in v2.0.0 once `frontend.nextjs`/`authentication`/`forms`/`tables` were implemented (see `TEMPLATE-REGISTRY.md`'s frontend section) — `ai.frontend-agent` now invokes real graph nodes, not just a planning artifact.

## Narrower agents (lighter treatment: agent.yaml + system-prompt.md + README.md)

| Agent | Note |
|---|---|
| [`ai.api-agent`](api-agent/) | Refines `api.schema.json` after `ai.backend-agent` |
| [`ai.authentication-agent`](authentication-agent/) | Invokes `authentication.*`/`authorization.*` |
| [`ai.security-agent`](security-agent/) | Focused re-check of validation's security category |
| [`ai.devops-agent`](devops-agent/) | Invokes `devops.*`, runs after testing |
| [`ai.documentation-agent`](documentation-agent/) | Invokes `documentation.*` |
| [`ai.code-review-agent`](code-review-agent/) | Convention conformance, terminal step |
| [`ai.integration-agent`](integration-agent/) | No `integrations.*` nodes are registered — plans only |

## Planned

| Agent | Status |
|---|---|
| [`ai.orchestrator`](orchestrator/) | `planned` — see note above |

## Lifecycle

```
Generate → Validate → Errors? → Repair → Validate → Test → Review → Complete
```

`ai.validation-agent` sits at the center of this loop (see its `README.md`). The typical full run: `requirements-agent → architect-agent → {database, storage, authentication}-agent (fan-out) → backend-agent → frontend-agent → api-agent → testing-agent → validation-agent (repair loop) → devops-agent → documentation-agent → validation-agent (final) → security-agent → code-review-agent → Complete`.
