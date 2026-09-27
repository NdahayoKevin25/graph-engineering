# Contributing a Template

This is the step-by-step process for adding a new graph node to `graph-templates/`. Read `TEMPLATE-SPEC.md` and `GRAPH-NODE-SPEC.md` first — this document is the checklist, those are the contract.

## 1. Create the template directory

`graph-templates/<category>/<subcategory>/` — pick a category from the existing top-level directories (`project`, `backend`, `database`, `storage`, `authentication`, `authorization`, `api`, `testing`, `devops`, `ai`, `documentation`) unless you're genuinely introducing a new one (see §11). The directory name becomes the second segment of the node's `id`.

## 2. Write `template.yaml`

Follow `TEMPLATE-SPEC.md` §2's full field list. Non-negotiable fields: `id` (must match the directory, `TEMPLATE-SPEC.md` §2 field notes), `version: 1.0.0` for a new template, `status` (`implemented` only once §3–9 below are done — start as `planned` if you're registering intent before writing code), `type: graph-node`.

## 3. Write the input schema

`inputs.schema.json` — a real JSON Schema (draft 2020-12), `additionalProperties: false`, every field from `template.yaml`'s `inputs` list represented with its actual type/`default`/`pattern` constraints. This is what an orchestrating agent validates a call against before invoking `generate`.

## 4. Write the output schema

`outputs.schema.json` — same rigor, for what the node reports back after running. If the node's `files.create` paths are templated by input (e.g. `src/repository/{{input.entityName}}.ts`), the output's `files` array should list resolved paths for the example in `examples/`, not the literal placeholder.

## 5. Define dependencies

`dependencies.json` — a flat, tooling-readable mirror of `template.yaml`'s `dependencies` block (`TEMPLATE-SPEC.md` §5). Every package needs a version range; every template dependency needs a `relationship` (`requires`/`extends`/`conflicts`).

## 6. Implement the declared files or modifications

Real, compilable code — never pseudocode or `// TODO: implement this`. If `files.create` declares new output, provide a non-empty `files/` directory. If the file is entity/input-driven, name it `*.template` and use `{{input.*}}`/`{{#each}}`/`{{#if}}` placeholders (`TEMPLATE-SPEC.md` §3, §6). Match the conventions already established by the templates in the same category — read a sibling template's `files/` before writing your own; consistency across the library matters more than any individual template's local elegance. If your node only modifies an existing file, add the entry to `files.modify` in `template.yaml` with an explicit `operation` (§2 field notes) and implement an audited modifier; it need not invent a `files/` payload. Never silently overwrite a file another node owns.

## 7. Add tests

Prove the generated code or modification actually does what the node claims. Prefer node-local `tests/` for emitted business logic; central generated-code/runtime tests are appropriate for shared renderers and modify-only nodes. Unit-test business logic against a mocked dependency (see `backend/service/tests/EntityService.test.ts` for the pattern); use `testing.api`'s supertest convention for anything that mounts a route. A template with no way to verify its own output is not done.

## 8. Add validation

`template.yaml`'s `validation.checks` — at minimum `file-exists` for everything in `files.create`, `exports` for anything downstream nodes import by name, and a `build` check (`npm run build`). Write `prompts/validate.md` describing how an agent should interpret a failure (which check failing implies which fix — see `backend/repository/prompts/validate.md` for the pattern of distinguishing "this node's own bug" from "a downstream node skipped a modify step").

## 9. Add documentation

`README.md` in the **What / When / Requires / Configure via / Produces / Connects to / Test / Validate / Security** bullet format used throughout this library — this is what lets an agent (or a human) answer all fifteen questions in the original brief's §25 without reading the implementation. Write `prompts/generate.md` and `prompts/modify.md` as terse, numbered, agent-executable instructions, not prose explanations (the README explains *why*; the prompts say *what to do*).

## 10. Add an example

`examples/*.json` — `{ "inputs": {...}, "expectedOutputs": {...} }`, at least one, using realistic values (see `backend/repository/examples/product.json`). This doubles as documentation and as a fixture `tools/validate-templates` or a future test runner can execute against.

## 11. Register the template

Add an entry to `TEMPLATE-REGISTRY.md`'s table for its category and to `template-registry.json` (same shape as every other entry — `id`, `name`, `version`, `category`, `tags`, `inputs`, `outputs`, `compatibleNodes`, `status`). A template that exists on disk but isn't in the registry is invisible to an orchestrating agent — the registry, not directory scanning, is the intended discovery mechanism (directory scanning is what `tools/validate-templates` uses to catch registry drift, not what an agent should rely on at runtime).

## 12. Run template validation

```sh
cd tools/validate-templates && npm install && node index.js ../..
```

Fix every reported error before opening a PR. Warnings are worth a look but not blocking.

## Adding a new technology (a new implementation of an existing category)

E.g. a `backend/fastify/` alongside `backend/express/`. Follow §1–12 exactly, but additionally: keep the node's `inputs`/`outputs` shape **compatible** with the existing implementation in that category where the concepts overlap (a `database.postgres` node's repository output should look like `database.neon-postgres.connection`'s, not a different shape) — this is what lets `api.crud` and other composition nodes stay stack-agnostic. If full compatibility isn't possible, say so explicitly in the README's Security/Connects-to sections rather than silently diverging.

## Adding a new category

Only when a template genuinely doesn't fit any existing category (`REFERENCE_ARCHITECTURE.md` §11 and this library's current category list should both be read first — most "new" categories turn out to be a subcategory of an existing one). Update this file's §1 category list, `graph-templates/README.md`'s directory tree, and `TEMPLATE-REGISTRY.md`'s section list in the same PR.

## Creating a new AI agent

Agents live in `graph-templates/ai/<agent-name>/` and follow a different, lighter structure than a code-generating template — see `graph-templates/ai/README.md` and any existing agent (e.g. `ai/architect-agent/`) for the `agent.yaml`/`system-prompt.md`/`input-schema.json`/`output-schema.json`/`tools.json`/`validation.md` shape. The same principle applies: `system-prompt.md` should be a real, directly-usable system prompt, not a description of one.

## Deprecating or bumping a template

See `TEMPLATE-SPEC.md` §7 (versioning) and its deprecation note. A MAJOR bump requires a `## Migrating from <prev-major>` section in the template's own README — write it before merging, not after.
