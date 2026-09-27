# tools/validate-graph

Validates a generated project's versioned architecture and artifact contracts against the graph template registry. It is a read-only mechanical check; it does not run generation, application tests, or repairs.

```sh
npm ci --prefix graph-templates/tools/validate-graph
node graph-templates/tools/validate-graph <project-directory> graph-templates
npm test --prefix graph-templates/tools/validate-graph
```

It exports `validate(projectDir, templatesRoot)`, `normalizeArchitecture()`, `normalizeManifest()`, and `normalizeArtifactType()` for application adapters. Importing the module does not run the CLI. See `ARTIFACT-SPEC.md` for v1 singleton import and v2 invocation identity.

## Enforced checks

- All present, recognized artifact files validate against their JSON Schema 2020-12 contracts. Architecture is required; unknown major architecture versions fail. Documented filename/type aliases normalize at the boundary, and duplicate artifact files fail.
- Invocations have unique IDs, implemented registry templates, complete requirements, valid prerequisite bindings, and no template conflicts. Repeated prerequisites require explicit bindings.
- Required dependencies, selected extensions, and explicit edges reference invocations and obey order. Cycles through any of these edge kinds fail.
- Backend invocations with no incoming composition dependency produce orphan warnings independently for each instance.
- Required environment keys must appear as actual assignments in `.env.example`; comments and substring matches do not count.
- Manifest entries resolve to their architecture invocation and template. Major-version drift produces warnings.
- Declared test suites resolve to invocations. A repeated template's suite cannot implicitly cover all its instances. Missing declared coverage produces warnings; a suite record is not evidence that tests passed.

## Output

```json
{ "valid": false, "errors": [{ "rule": "missing-dependencies", "check": "missing-dependencies", "nodeId": "backend.service:Invoice", "message": "..." }], "warnings": [], "repairs": [] }
```

`rule` is canonical; `check` remains as a deprecated compatibility alias. `nodeId` in findings identifies an invocation. Exit status is zero exactly when there are no errors. Repairs are suggestions for missing environment keys only; validation never writes files.

This checker does not resolve generated-language imports or arbitrary application-domain references between artifacts, and it does not prove an application builds. Run the generated application's compiler and tests separately. The coarse CLI's opt-in `create-graph-app/scripts/smoke-generated-apps.js` installs and builds representative frontend, backend, and full-stack projects.
