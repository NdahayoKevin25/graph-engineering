# Template Specification

Defines the on-disk shape of a template and the full `template.yaml` schema. See `GRAPH-NODE-SPEC.md` for the conceptual contract this schema encodes, and `CONTRIBUTING.md` for the step-by-step process of adding one.

## 1. Directory layout

Every template lives at `graph-templates/<category>/<name>/` and contains:

```
template-name/
├── README.md              Human-facing: what/when/how — answers TEMPLATE-QUALITY §26 questions
├── template.yaml           Machine-readable contract (schema below)
├── inputs.schema.json      JSON Schema for inputs
├── outputs.schema.json     JSON Schema for outputs
├── dependencies.json       Resolved package/service/template dependency list (see §5)
├── files/                  Source files this node creates, as literal templates
│   └── ...                 (Handlebars-style {{placeholders}}, see §6)
├── prompts/
│   ├── generate.md          Instructions an AI agent follows to run `generate`
│   ├── modify.md             Instructions to run `modify` against an existing install
│   └── validate.md            Instructions to run `validate` / interpret failures
├── tests/                  Tests proving the generated code works
└── examples/               At least one filled-in example of inputs → resulting files
```

A template with `status: planned` in its `template.yaml` may omit `files/`, `tests/`, and `examples/` — it exists in the registry as a documented gap, not yet implemented (see §8 Status).

## 2. `template.yaml` schema

```yaml
id: storage.aws-s3.upload            # dotted, matches directory path, globally unique
name: AWS S3 Upload
version: 1.0.0                        # semver — see §7
description: >
  Uploads a buffered file to an S3-compatible bucket under a collision-resistant
  key and returns the object key. Pairs with storage.aws-s3.presigned-url for reads.
category: storage
subcategory: aws-s3
status: implemented                   # implemented | planned | experimental

type: graph-node
actions: [generate, detect, modify, validate, test]

inputs:
  - name: bucketEnvVar
    type: string
    required: false
    default: AWS_BUCKET_NAME
    description: Name of the env var holding the target bucket.

outputs:
  - name: files
    type: array<string>
    description: Paths created or modified.
  - name: exports
    type: array<string>
    description: Named exports downstream nodes can import.

dependencies:
  packages:
    - name: "@aws-sdk/client-s3"
      version: "^3.1128.0"
  services:
    - s3-compatible-storage
  templates:
    - id: storage.aws-s3
      relationship: requires
    - id: storage.file-validation
      relationship: extends

environment:
  variables:
    - name: AWS_BUCKET_NAME
      required: true
      secret: false
      description: Target bucket name.
      usedBy: [storage.upload]

files:
  create:
    - path: src/repository/FileUpload.ts
      source: files/FileUpload.ts.template
  modify: []

compatible_with:
  upstream: [storage.aws-s3.client, backend.express]
  downstream: [api.crud, storage.aws-s3.presigned-url]

consumes:
  artifacts: [storage.schema.json]
produces:
  artifacts: [storage.schema.json]

idempotency:
  strategy: detect-and-skip          # see §4
  detection: "file src/repository/FileUpload.ts exists and exports uploadFileToS3"

validation:
  checks:
    - type: file-exists
      path: src/repository/FileUpload.ts
    - type: exports
      path: src/repository/FileUpload.ts
      names: [uploadFileToS3]
    - type: build
      command: npm run build

testing:
  strategy: unit
  location: tests/upload.test.ts
  command: npm test -- upload.test.ts

security:
  considerations:
    - Objects are private by default; reads must go through a presigned URL (storage.presigned-url), never a public bucket policy.
    - Keys are namespaced (uploads/) and randomized (UUID) to prevent enumeration and collisions.
    - Pair with storage.file-validation to enforce MIME/size limits — this node alone does not.

documentation:
  required: [README.md]
```

### Field notes

- **`id`** is the template primary key used by the registry and other templates' `dependencies.templates`/`compatible_with`. Architecture v2 uses a separate `instanceId` for each invocation; multiple invocations may share the same template `id`. Renaming an `id` is a breaking change (§7).
- **`inputs`/`outputs`** mirror JSON Schema types (`string`, `number`, `boolean`, `array<T>`, `object`) and are the human-readable summary; `inputs.schema.json`/`outputs.schema.json` are the enforceable source of truth an agent validates against before/after execution.
- **`dependencies.templates[].relationship`**: `requires` (hard — orchestrator errors if missing), `extends` (soft — enhances behavior if present, e.g. file-validation extending upload), `conflicts` (mutually exclusive with this node).
- **`compatible_with`** is advisory graph-composition guidance, not an execution dependency — see `GRAPH-NODE-SPEC.md` §5.
- **`files.create`** entries map a source template file to a destination path; **`files.modify`** entries (see `backend/express/template.yaml` for a populated example) name an existing file and an `operation` so the executor never blindly overwrites a file it didn't create. Recognized operations:
  - `insert-import` — adds one import statement (deduplicated by module specifier).
  - `append` — adds content to the end of the file.
  - `merge-json` — deep-merges a JSON fragment into an existing JSON file (e.g. adding `package.json` scripts).
  - `insert-before-marker` — inserts a line immediately before a named marker comment (e.g. `helpers.ts`'s `// ENV-VAR-FIELDS:`).
  - `replace-marker` — replaces a marker comment (and, where documented per-node, the line(s) immediately following it) with real code, used when a root node ships a self-contained fallback that a specific downstream node upgrades (see `project.node-express`'s inline fallback error handler, replaced by `backend.error-handler`).
  - `insert-into-array` — appends one element to a named literal array (e.g. `helpers.ts`'s `requiredEnvironmentVariables: readonly string[] = []`), used whenever more than one node contributes to the same array over time (`database.neon-postgres.connection`, `authentication.jwt`, and `storage.aws-s3` all target this one array).
  - `merge-import` — like `insert-import`, but merges named imports into an existing `import { ... } from 'module'` statement rather than adding a new statement for the same module.
  - `replace-method` — replaces one named method/function body in an existing file in place (e.g. `api.crud` upgrading `backend.repository`'s generated `findMany` to add allowlisted filtering/sorting) — the executor must locate the method by name, not by line number, since earlier `modify` steps may have shifted it.

## 3. File templating (`files/*.template`)

Files under `files/` use `{{input.name}}` placeholders resolved from the node's `inputs` at generate time (e.g. `{{input.entityName}}`, `{{input.entityNamePlural}}`). Files with no placeholders are copied verbatim. The convention mirrors the reference app's actual code — a template file is real, compilable TypeScript with placeholders substituted in, not pseudocode. `{{#each input.arrayField}} ... {{/each}}` and `{{#if input.booleanField}} ... {{/if}}` blocks are supported (see `backend/repository/files/schema.fragment.ts.template` and `backend/express/files/EntityRoutes.ts.template` for real examples). `{{json input.value}}` serializes an input value as a JS/JSON literal inline (used by `database.seed` to emit sample-row object literals) — see §6 for the full placeholder reference.

## 4. Idempotency strategies

| Strategy            | Behavior on second `generate` call                                      |
|----------------------|---------------------------------------------------------------------------|
| `detect-and-skip`    | If `idempotency.detection` matches, no-op and report already-present.    |
| `detect-and-merge`   | If present, run the node's `modify` action instead (e.g. add a new migration rather than rewrite schema.ts). |
| `version-check`      | Compare the installed node's recorded version (see `manifest.json` convention below) against this node's `version`; migrate if older, skip if equal, warn if newer. |

Every project generated by this system SHOULD maintain `.graph/manifest.json` as `{ schemaVersion: "2.0.0", projectName, nodes: { [instanceId]: { templateId, version, generatedAt, files: [...] } } }`. Detection and version checks use the instance key; template lookup uses `templateId`. The legacy unversioned `{ projectName, nodes: { [templateId]: { version, generatedAt, files } } }` imports without loss for singleton instances. Generating this manifest is the responsibility of `project/node-express` (or another `project/*` node); only executed instances belong in the manifest.

## 5. `dependencies.json`

A flat, resolved view of `template.yaml`'s `dependencies` block, meant for tooling (e.g. `tools/validate-templates`) to consume without parsing YAML:

```json
{
  "packages": [{ "name": "@aws-sdk/client-s3", "version": "^3.1128.0" }],
  "services": ["s3-compatible-storage"],
  "templates": [{ "id": "storage.aws-s3", "relationship": "requires" }]
}
```

## 6. Placeholders reference

| Placeholder                | Resolves to |
|------------------------------|-------------|
| `{{input.<name>}}`           | An input value |
| `{{input.<name>Plural}}`     | Convention: caller supplies the plural form as a sibling input when pluralization isn't mechanical |
| `{{input.<name>Camel}}`      | Convention: caller supplies the camelCase form of a PascalCase input (e.g. `entityNameCamel` alongside `entityName`) when the executor doesn't derive it automatically |
| `{{env.<VAR>}}`               | Literal reference to `process.env.<VAR>` — emitted as code, not resolved at generate time |
| `{{project.name}}`            | The consuming project's name, read from `architecture.json` |
| `{{#each input.<arrayField>}} ... {{/each}}` | Repeats the block once per array element, exposing `this` as the current element (e.g. `{{this.name}}`) |
| `{{#if input.<booleanField>}} ... {{/if}}`   | Includes the block only when the input is truthy |
| `{{json input.<value>}}`      | Serializes an input value (object/array/string) as an inline JS/JSON literal — used where a template needs to emit structured data as code, e.g. `database.seed`'s sample rows |

## 7. Versioning

Semantic versioning (`MAJOR.MINOR.PATCH`) per template `id`:

- **PATCH** — bug fix in generated code, no change to `inputs`/`outputs`/`dependencies` shape.
- **MINOR** — new optional input, new output, new file created — backward compatible.
- **MAJOR** — removed/renamed input or output, changed required dependency, changed file paths — breaking. Requires a note in the template's `README.md` under `## Migrating from <prev-major>` and a bump reflected in `TEMPLATE-REGISTRY.md`.

Deprecation: a template scheduled for removal sets `status: experimental` is not it — deprecation is signaled by adding a `deprecated: true` and `deprecated_in_favor_of: <id>` field to `template.yaml`; the registry and validators surface a warning (not an error) when such a node is used.

## 8. Status

- **implemented** — has `files/`, `tests/`, `examples/`, passes `tools/validate-templates`.
- **planned** — registered (has `template.yaml`, no `files/`) so the registry documents the intended shape of the graph; an orchestrator must refuse to `generate` it.
- **experimental** — implemented but contract (`inputs`/`outputs`) may still change without a major version bump; usable but the orchestrator should warn.
