# authorization.tenant-isolation

The engine now provides an audited deterministic Tenant isolation renderer. Its
credential, identity, cookie, concurrency and authorization contract is documented
in [the executable authentication guide](../../../docs/authentication-runtime.md).
That runtime emits reviewed source and tests; it does not execute the historical
prompt/asset snippets below, configure secrets, deliver email, or authorize a
deployment automatically. Existing custom code requires explicit reconciliation.

**What.** `requireTenant` — middleware reading a `tenantId` claim off the authenticated user, attaching `req.tenantId`, 401-ing if absent. `withTenantScope(baseCondition, table, tenantId)` — a composable Drizzle helper (`and(baseCondition, eq(table.tenantId, tenantId))`) a repository method calls to scope its query.

**When.** After `authentication.jwt`. Used by any multi-tenant application's `backend.repository`/`api.crud` generation and route middleware chains.

**Requires.** `authentication.jwt` (for `req.user`, which must carry a `tenantId` claim — added by whichever node issues tokens for this application, e.g. `authentication.jwt` extended with a tenant claim, or `authentication.oauth`).

**Produces.** `src/middlewares/tenantMiddleware.ts` (`requireTenant`), `src/utils/tenantScope.ts` (`withTenantScope`).

**Connects to.** Downstream: `backend.repository` (a tenant-scoped entity's `findMany`/`findById`/`update`/`remove` call `withTenantScope`), `backend.express`/`api.crud` (mount `requireTenant` before any tenant-scoped route).

**Test.** `npm test -- tenantMiddleware` — missing `tenantId` claim → 401; present → `req.tenantId` set and `next()` called with no error.

**Validate.** Both files + both exports exist; `npm run build` passes.

**Security — read this before treating a table as tenant-scoped.** This node supplies the *plumbing* (`req.tenantId`, one scoping helper) — it does **not** automatically rewrite any existing or future `backend.repository`-generated query to include a tenant filter. That is each entity's own responsibility at generation time: mark the table `tenantScoped: true` in `database.schema.json` and have its repository call `withTenantScope` around every condition it builds. The #1 multi-tenant bug class is exactly this — one method that forgot the filter, leaking cross-tenant data — so `tools/validate-graph` is meant to flag any `tenantScoped: true` table whose repository code never references `tenantId`; treat that warning as a security bug, never a style nit. This is a stated scope boundary, not an oversight: a node that silently rewrote arbitrary generated code to "add" tenant filtering would be far more dangerous to get wrong than one that requires each entity to opt in explicitly.
