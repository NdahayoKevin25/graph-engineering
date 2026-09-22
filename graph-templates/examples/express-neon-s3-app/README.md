# Example: express-neon-s3-app

Recreates the reference application's stack (Express + Neon Postgres/Drizzle + S3-compatible storage + JWT auth) **and improves on it** using this template library — fixing every gap `REFERENCE_ARCHITECTURE.md` §8 documents (thin controllers, consistent success envelope, Zod validation, RBAC actually enforced, refresh tokens, file-type validation, errors thrown instead of swallowed) — plus adds one full CRUD resource (`Product`) the reference app never had, to demonstrate `api.crud`.

## What this demonstrates

- A composition request ("Express backend, Neon Postgres, S3 storage, JWT auth + refresh, RBAC, one CRUD entity with pagination/filtering/sorting, Docker + CI") resolved into a concrete, dependency-ordered node list — see `graph.json`.
- That resolved list expressed as the actual `architecture.schema` artifact instance an `ai.architect-agent` run would produce — see `architecture.json`.
- The downstream artifacts every other agent would produce from it: `database.json`, `api.json`, `auth.json`, `storage.json`, `test.json`, `deployment.json` (all validate against their schemas in `../../artifacts/`).

## Files

| File | Artifact type |
|---|---|
| `graph.json` | Informal: the human composition request + the resolved node graph, for readability |
| `architecture.json` | `architecture` — legacy v1 singleton artifact, imported losslessly into v2 |
| `database.json` | `database.schema` |
| `api.json` | `api.schema` |
| `auth.json` | `auth.schema` |
| `storage.json` | `storage.schema` |
| `test.json` | `test.schema` |
| `deployment.json` | `deployment.schema` |

## Differences from the reference app (intentional)

The current graph validator reports nine existing missing-test declarations in this example. Registry testing metadata now makes those coverage gaps visible; historical suite statuses in example JSON are not current execution evidence. Contract validation remains successful, and actual generated applications must be compiled and tested separately.

See `REFERENCE_ARCHITECTURE.md` §8–9 for the full reasoning. In short: a controller layer now exists (reference app had routes calling services directly); success responses are `{ message, data }` everywhere (reference app was ad hoc); request bodies are Zod-validated (reference app hand-rolled one validator inline); `role` is actually enforced via `authorization.rbac` (reference app defined it and never checked it); a refresh token exists (reference app's README promised one, it didn't ship); `storage.upload` throws instead of swallowing errors and is paired with `storage.file-validation` (reference app accepted any file of any size); CI exists (reference app had none).
