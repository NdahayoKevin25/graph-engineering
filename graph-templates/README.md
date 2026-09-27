# graph-templates

A library of composable, machine-readable engineering templates ("graph nodes") that an AI orchestration system uses to build full-stack applications by composition instead of by inventing everything from scratch each time. Built by inspecting a reference Express + Neon Postgres + AWS S3 backend (`../reference-app/`, analyzed in `../REFERENCE_ARCHITECTURE.md`) and extracting its reusable patterns, while fixing the gaps that single-feature reference app never had to face (see `REFERENCE_ARCHITECTURE.md` §8–9).

## Purpose

> Instead of asking an AI agent to invent an entire application from scratch, give it a library of proven engineering templates it can compose, configure, connect, and validate.

Every template is a self-contained **graph node**: identity, typed inputs/outputs, explicit dependencies on other nodes, the files it creates/modifies, how to validate it worked, and its security considerations — all machine-readable, so an orchestrating agent can select and sequence nodes without reading their implementation first.

## Architecture

```
Requirement → Artifact → Graph Node → Template → Code → Validation → Test → Artifact
```

Agents (`ai/`) turn a natural-language ask into `requirements.json`, resolve it into an `architecture.json` (a specific, ordered list of graph node ids — see `GRAPH-NODE-SPEC.md`), and each node's `generate` action turns its declared inputs into real files. Nodes exchange state through **versioned JSON artifacts** (`artifacts/`, `ARTIFACT-SPEC.md`), never natural language. `ai.validation-agent` + `tools/validate-graph` close the loop: `Generate → Validate → Repair → Validate → Test → Review → Complete`.

## Directory structure

```
graph-templates/
├── README.md, CONTRIBUTING.md, TEMPLATE-REGISTRY.md   this file, how to add a template, human-readable index
├── GRAPH-NODE-SPEC.md, TEMPLATE-SPEC.md, ARTIFACT-SPEC.md   the three contracts everything else follows
├── template-registry.json           machine-readable index, derived — see tools/generate-registry
├── artifacts/                       JSON Schemas for the 10 structured handoff documents
├── project/          node-express, nextjs, vite-react (independent backend and frontend roots)
├── backend/           express·controller·service·repository·middleware·error-handler·validation·pagination·api-response
├── database/          neon-postgres·migrations·transactions·seed  (entity CRUD lives in backend/repository, see its README)
├── storage/            aws-s3·upload·download·presigned-url·delete·file-validation
├── authentication/     jwt·password·oauth·session
├── authorization/      rbac·tenant-isolation·roles  (+ planned: permissions)
├── api/                 crud  (+ planned: search, webhooks — pagination/filtering/sorting live inside crud + backend/pagination)
├── frontend/            nextjs·react API clients; Next.js-specific authentication·forms·tables·dashboards
├── testing/            unit·integration·api·fixtures·mocks
├── devops/             docker·github-actions·environments  (+ planned: aws, deployment)
├── documentation/      api·architecture·setup·agent-context
├── ai/                 16 orchestration agent definitions (requirements → architect → database/backend/storage/auth → testing → validation → devops → documentation → security → code-review → integration)
├── tools/               validate-templates, validate-graph, generate-registry — real, runnable Node scripts
└── examples/            express-neon-s3-app (recreates the reference app), multi-tenant-saas (same library, different domain)
```

`implemented` vs. `planned` vs. `experimental` status is tracked per-template in its own `template.yaml` (`TEMPLATE-SPEC.md` §8) and rolled up in `TEMPLATE-REGISTRY.md`.

## The node contract

Full detail in `GRAPH-NODE-SPEC.md`. Short version: every node has an `id` (dotted, e.g. `storage.upload`), typed `inputs`/`outputs`, `dependencies.templates` (each tagged `requires`/`extends`/`conflicts`), `compatible_with` (advisory), `consumes`/`produces` artifacts, an `idempotency` strategy, and `validation.checks` an agent can run mechanically. `TEMPLATE-SPEC.md` §2 has the full `template.yaml` schema with a worked example.

## Artifact system

Ten JSON Schemas in `artifacts/` (`requirements`, `architecture`, `database.schema`, `api.schema`, `auth.schema`, `storage.schema`, `frontend.schema`, `integration.schema`, `test.schema`, `deployment.schema`) define the structured documents agents pass to each other. Every instance shares one envelope (`$schema`, `artifactType`, `version`, `metadata`, `data`) — see `ARTIFACT-SPEC.md`.

## Audited renderers

The Graph Engineering platform (`packages/engine` in the platform repository) renders every `implemented` node deterministically through an audited renderer, and its engine tests check each node's generated code; some template manifests and READMEs point at those tests. The manifests, files, prompts, schemas and the tools in `tools/` remain usable on their own, without the platform.

## Registry

`template-registry.json` is **derived, never hand-edited** — regenerate it after adding/changing a template:

```sh
node tools/generate-registry/index.js . > template-registry.json
```

It's the discovery index (`id`, `tags`, `inputs`, `outputs`, `dependsOn`, `environment`, `compatibleNodes`) an orchestrator queries instead of opening every `template.yaml`. `TEMPLATE-REGISTRY.md` is the human-readable companion.

## Agent orchestration

`ai/` holds 16 agent definitions: 8 with full `agent.yaml`/`system-prompt.md`/input-output schemas/`tools.json`/`validation.md`/`examples/`, 7 lighter (`agent.yaml`+`system-prompt.md`+`README.md`), and 1 planned stub (`orchestrator`). See `ai/README.md` for the roster and the typical run order. These agents are prompt/schema definitions for whatever system executes them (e.g. this very kind of session) — there is no bundled runtime orchestrator; `ai/orchestrator` is intentionally `planned`.

## Template composition

An agent resolves "Express + Neon + S3 + JWT + RBAC + CRUD + Docker + CI" into a concrete, topologically-sorted node list by following each node's `dependencies.templates[].relationship: requires` edges. See `examples/express-neon-s3-app/architecture.json` and `examples/multi-tenant-saas/architecture.json` for two fully worked, machine-validated instances.

## Validation & repair

```sh
node tools/validate-templates/index.js .          # validates the template library itself
node tools/validate-graph/index.js <project> .    # validates one generated project's composed graph
```

`validate-graph` checks: missing dependencies, circular dependencies, invalid connections, missing required env vars, duplicate/conflicting nodes, version drift (manifest vs. registry), orphaned composition-layer nodes, and missing test coverage — the same categories `ai.validation-agent`'s `system-prompt.md` enumerates (see its README for how the two relate: the tool is the mechanical checker, the agent is what proposes repairs).

## Testing

Every `implemented` template ships its own `tests/` proving its generated code works (unit-level, mocking one layer down — see `backend/repository/tests/` for the canonical pattern). `testing/unit`, `testing/integration`, `testing/api`, `testing/fixtures`, `testing/mocks` are themselves nodes that set up the *generated project's* own test tooling (Vitest, supertest, fixture factories, DB mocks).

## Versioning

Semantic versioning per template `id` — `TEMPLATE-SPEC.md` §7 defines what counts as PATCH/MINOR/MAJOR and how deprecation is signaled (`deprecated: true` + `deprecated_in_favor_of`).

## Adding a new template / new technology / new AI agent

See `CONTRIBUTING.md` for the full checklist. Short version: copy an existing template in the same category as a starting shape (e.g. `backend/repository/` for a new backend-layer node), fill in all 9 required pieces (`TEMPLATE-SPEC.md` §1), run `tools/validate-templates`, regenerate the registry. Adding a new *technology* (e.g. `backend/fastify/` alongside `backend/express/`) follows the same process — see §23 discipline in `REFERENCE_ARCHITECTURE.md`: implement the reference stack first, mark alternates `planned` until they're real. Adding a new AI agent: copy `ai/storage-agent/` (a mid-complexity flagship example) and follow `ai/README.md`'s file list.
