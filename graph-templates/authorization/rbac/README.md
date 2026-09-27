# authorization.rbac

The engine now provides an audited deterministic RBAC renderer. Its
credential, identity, cookie, concurrency and authorization contract is documented
in [the executable authentication guide](../../../docs/authentication-runtime.md).
That runtime emits reviewed source and tests; it does not execute the historical
prompt/asset snippets below, configure secrets, deliver email, or authorize a
deployment automatically. Existing custom code requires explicit reconciliation.

**What.** `requireRole(...roles)` — an Express middleware factory. Reads `req.user.role` (set by `authentication.jwt`'s `authMiddleware`) and calls `next(new APIError('Forbidden', 403))` if the caller's role isn't in the allowlist; `next(new APIError('Authentication required', 401))` if `req.user` is missing entirely.

**When.** After `authentication.jwt`, `backend.error-handler`. Composed into a route's middleware chain by `backend.express`/`api.crud`, always placed after `authMiddleware`.

**Requires.** `authentication.jwt` (for `req.user`), `backend.error-handler` (`APIError`).

**Produces.** `src/middlewares/rbacMiddleware.ts` exporting `requireRole`.

**Connects to.** Downstream: any generated route needing role-gating, e.g.:
```ts
router.delete('/:id', authMiddleware, requireRole('admin'), asyncHandler(controller.remove));
```

**Test.** `npm test -- rbacMiddleware` — an `admin`-only route rejects a `customer` role with 403, accepts `admin`, and rejects a missing `req.user` with 401 (not a crash).

**Validate.** File + `requireRole` export exist; `npm run build` passes.

**Security.** Ordering matters: `requireRole` must always run after `authMiddleware`. This node defends against getting that wrong — a missing `req.user` produces a clean 401, never a thrown/uncaught `TypeError` from reading `.role` off `undefined`, and never a silent pass-through. Every route that should be role-gated must list `requireRole(...)` explicitly in its middleware chain; this node has no schema-driven auto-detection of which routes need it.
