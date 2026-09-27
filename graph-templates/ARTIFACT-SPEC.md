# Artifact Specification

Artifacts are the structured, versioned JSON documents agents pass to each other instead of natural language (§10–11 of the project brief). This document defines the shared envelope every artifact uses and indexes the ten artifact schemas in `artifacts/`.

## 1. Why artifacts, not chat transcripts

An agent should never have to re-derive "what did the Database Agent decide?" by reading prose. It reads `database.schema.json`. This makes the pipeline replayable, diffable, and independently validatable (`ai/validation-agent`), and lets a human or a different agent resume the graph mid-pipeline from any artifact.

## 2. Shared envelope

Every artifact file is a single JSON object with this envelope, wrapping content specific to that artifact type in `data`:

```json
{
  "$schema": "../artifacts/database.schema.json",
  "artifactType": "database.schema",
  "version": "1.0.0",
  "metadata": {
    "generatedBy": "database-agent",
    "generatedAt": "2026-01-15T10:00:00Z",
    "projectName": "acme-shop",
    "sourceArtifacts": ["architecture.json"]
  },
  "data": { }
}
```

- **`artifactType`** matches the schema's own `id` (dotted, no `.json`) — e.g. `database.schema`.
- **`version`** is the artifact *instance's* schema version (semver), independent of any template version — allows a schema to evolve (§6 below) while old artifact files remain identifiable.
- **`metadata.generatedBy`** names the agent or template `id` that produced it — this is the audit trail.
- **`metadata.sourceArtifacts`** lists the artifacts this one was derived from — this is how the pipeline's DAG (not just its linear happy-path) is reconstructed by the Validation Agent when checking for orphans or stale derivations.
- **`data`** is validated against the artifact-specific schema's `properties.data`.

## 3. The ten artifacts

| File | Produced by | Consumed by |
|---|---|---|
| `requirements.schema.json` | `ai/requirements-agent` | `ai/architect-agent` |
| `architecture.schema.json` | `ai/architect-agent` | every downstream agent |
| `database.schema.json` | `ai/database-agent` | `ai/backend-agent`, `ai/testing-agent` |
| `api.schema.json` | `ai/api-agent` (or `ai/backend-agent`) | `ai/frontend-agent`, `ai/testing-agent`, `ai/documentation-agent` |
| `auth.schema.json` | `ai/authentication-agent` | `ai/backend-agent`, `ai/frontend-agent` |
| `storage.schema.json` | `ai/storage-agent` | `ai/backend-agent`, `ai/frontend-agent` |
| `frontend.schema.json` | `ai/frontend-agent` | `ai/testing-agent`, `ai/documentation-agent` |
| `integration.schema.json` | `ai/integration-agent` | `ai/testing-agent`, `ai/devops-agent` |
| `test.schema.json` | `ai/testing-agent` | `ai/validation-agent` |
| `deployment.schema.json` | `ai/devops-agent` | `ai/validation-agent` |

These are schema filenames. Project artifacts conventionally use `database.json`, `architecture.json`, and so on. Canonical types are `requirements`, `architecture`, and `<name>.schema` for the remaining rows. The validator's import boundary accepts documented filename aliases (`architecture.schema.json`, `database.schema.json`, and the old typo `database.schema.schema.json`) without changing canonical exports. Unknown names are not guessed, and duplicate files for one artifact type are rejected.

## 4. Relationship to graph nodes

A node's `template.yaml` `consumes`/`produces` (see `GRAPH-NODE-SPEC.md` §6) names artifact types from this list. A node MAY consume an artifact partially (read only the fields it needs) but MUST NOT consume fields not declared in the schema — this is what lets the graph validator detect a node silently depending on undocumented structure.

## 5. Validation rules common to all artifacts

- `data` must validate against the schema's JSON Schema `data` definition — `additionalProperties: false` at every object level unless explicitly marked extensible, so typos and drift are caught immediately rather than silently ignored downstream.
- Every entity referenced by `$ref`-like string IDs (e.g. an API route referencing a database table name) must resolve. JSON Schema validation alone does not establish these cross-artifact relationships; the validator currently checks graph, manifest, and test invocation references, not arbitrary application-domain references.
- Timestamps are ISO-8601 UTC.

## 6. Schema evolution

The artifact's `version` identifies its contract version independently from the stable schema filename. Additive fields are MINOR; required-field/type/removal changes are MAJOR. Architecture v2 requires invocation identity. Test artifacts v1.1 add an optional `instanceId` to each suite; repeated templates require it to resolve coverage unambiguously. The architecture schema accepts v1 singleton documents for migration and v2 documents for current execution; unknown major versions are rejected.

## 7. Invocation identity and migration

Version `2.0.0` architecture nodes carry both `id` (registry template) and `instanceId` (unique invocation). For example:

```json
{ "id": "backend.service", "instanceId": "backend.service:Invoice", "order": 20,
  "inputs": { "entityName": "Invoice" },
  "bindings": { "backend.repository": "backend.repository:Invoice" } }
```

Bindings select an upstream instance by its template ID. Omit a binding only when exactly one invocation of that prerequisite exists. Bindings must point to the declared template. Selected `extends` prerequisites obey the same resolution and ordering rules. Explicit edges use `from` = dependent instance and `to` = prerequisite instance; both implicit and explicit edges participate in cycle and order checks. Conflicts still operate on template IDs.

The exported `normalizeArchitecture()` boundary returns a copy of a v1 singleton plan with `version: 2.0.0` and `instanceId = id`. It preserves input payloads and metadata. Duplicate legacy IDs cannot be migrated without explicit user intent and are rejected. No document is rewritten during validation. `normalizeManifest()` similarly preserves legacy singleton ledgers while adding `schemaVersion: 2.0.0` and `templateId` per entry; v2 ledger keys are invocation IDs. Test suites identify the template with `nodeId` and repeated invocations with `instanceId`.

The SaaS example now records separate `Project` and `Invoice` CRUD chains. The registry remains a template catalog, not an invocation ledger.
