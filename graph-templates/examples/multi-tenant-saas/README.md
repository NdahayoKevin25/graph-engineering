# Example: multi-tenant-saas

A worked artifact example for a project-management SaaS with tenants, projects, invoices, RBAC, and tenant isolation. The architecture uses version 2 invocation identities to represent two complete CRUD chains sharing the same five templates:

- `backend.repository:Project → backend.service:Project → backend.controller:Project → backend.express:Project → api.crud:Project`
- `backend.repository:Invoice → backend.service:Invoice → backend.controller:Invoice → backend.express:Invoice → api.crud:Invoice`

Each invocation retains its real registry `id`, its own entity inputs, and explicit bindings to repeated prerequisites. Shared infrastructure uses singleton IDs. Additional architecture edges point from dependents to prerequisites. The database artifact describes both tables; the frontend artifact remains a design artifact, not proof of generated frontend code.

The example manifest migrates the previously recorded Project entries to version 2 while preserving their versions, timestamps, and file lists. Invoice invocations are planned but have not been executed, so there are no fabricated Invoice manifest records; their declared suites use `status: not-run`. Historical example suite statuses are illustrative and do not establish current verification evidence.

## Validate

```sh
npm ci --prefix graph-templates/tools/validate-graph
node graph-templates/tools/validate-graph graph-templates/examples/multi-tenant-saas graph-templates
```

The graph is valid. Five missing-test warnings expose the existing declared coverage gaps for database connection, migrations, transactions, unit-testing setup, and API-testing setup. Previously these were hidden because the generated registry omitted testing metadata. All Project and Invoice test declarations resolve independently. This validates contracts and composition, not generated application behavior.
