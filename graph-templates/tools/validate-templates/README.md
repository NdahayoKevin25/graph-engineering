# tools/validate-templates

Checks every template in `graph-templates/` and verifies that the published registry is the generator's current output. This is a bounded structural check, not a full implementation or generated-app test. Run it from `graph-templates/`:

```sh
cd tools/validate-templates
npm install
node index.js ../..
```

## What it checks

- **Required fields present**: `id`, `name`, `version`, `description`, `category`, `subcategory`, `status`, `type: graph-node`, `actions`.
- **`id` matches its path**: `backend/error-handler/template.yaml`'s `id` must be `backend.error-handler` (category.subcategory) or a longer dotted id whose first two segments match the directory (a few ids in this registry, e.g. `database.neon-postgres.connection`, are intentionally three segments — the check only requires the first two to match the directory, the rest is free).
- **`version` is valid semver** (`MAJOR.MINOR.PATCH`).
- **`status` is one of** `implemented`, `planned`, `experimental`.
- **If `status: implemented`**: `README.md`, `inputs.schema.json`, `outputs.schema.json`, `dependencies.json`, a non-empty `prompts/` directory, and a non-empty `examples/` directory must exist. A non-empty `files/` directory is required when `files.create` has entries. A missing `tests/` directory is a warning unless `testing.strategy` is `none`; some renderers have central engine tests instead of node-local tests.
- **If `status: planned`**: only `template.yaml` is required — everything else is optional and skipped, per `TEMPLATE-SPEC.md` §8.
- **`inputs.schema.json`/`outputs.schema.json` parse as JSON**. This tool does not validate their JSON Schema semantics.
- **`dependencies.templates[].id` resolves** to a discovered `template.yaml` id. A dangling reference is an error.
- **No duplicate `id`** across the whole tree.
- **The published `template-registry.json` exactly matches the generator's current inventory and entries**, including identities, order, status, tags, dependencies and metadata. Only `generatedAt` is ignored. Missing/malformed registries or generator warnings fail validation.

This tool does not execute template hooks, validate specific prompt filenames, evaluate examples, or check advisory `compatible_with` references independently. The audited engine renderer checks exact output/modification manifests, while generated-code tests cover behavior.

## Output

```json
{ "valid": false, "templatesChecked": 55, "errors": [ { "template": "api.crud", "message": "registry entry differs from template.yaml; regenerate template-registry.json" } ], "warnings": [] }
```

Exit code is `1` if any `errors` entries exist, `0` otherwise (warnings never fail the run). Run `npm test` in this tool directory for focused drift regressions.
