# authorization.permissions

This audited node generates `PERMISSIONS` and `requirePermission` for a bounded
list of `resource:action` names. It is a granular enforcement extension to the
fixed-role `authorization.rbac` helper, not an automatic authorization system.
The renderer proposes source and tests; it never runs a template prompt or
installs dependencies.

An application-owned file at `src/services/permissionAuthorizer.ts` must export:

```ts
export async function hasPermission(
  userId: string,
  permission: string,
): Promise<boolean>;
```

Implement that adapter against current, trusted **user-global** grants in your
own durable store; revoke grants without stale authorization caches. The
middleware does not pass a tenant or resource ID to the adapter, so it does not
represent tenant-specific grants. For tenant-scoped resources, add and review
an independent tenant guard such as `authorization.tenant-isolation` and scope
every data operation to that tenant. Do not treat this gate alone as sufficient
for cross-tenant isolation. A sample no-op adapter is **not** emitted.
The renderer checks that the export exists, but cannot prove the application's
grant data, migration, or administrative grant endpoints are secure. Review and
test those before deployment.

Mount `authMiddleware` before `requirePermission(PERMISSIONS[0])` on each
protected route. Unknown permission names throw at route registration. Missing
or invalid identity gets 401; only an explicit `true` grant continues. All
other lookup results deny with 403, and lookup exceptions fail closed with a
generic 503. The node does not silently retrofit existing routes or define who
may grant/revoke permissions. Changed generated files require explicit review.

The runtime accepts 1–32 unique names matching
`resource:action` with lowercase ASCII letters, digits, `_` and `-`, each
component at most 32 characters. See `examples/orders.json` for inputs. Run
`npm test -- permissionMiddleware` and `npm run build` in the generated app;
the separate engine regression covers manifest integrity and fail-closed
behavior. Database migrations and production grant semantics require your own
review and verification.
