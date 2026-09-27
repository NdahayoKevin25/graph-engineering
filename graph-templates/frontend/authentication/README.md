# frontend.authentication

The audited runtime requires same-site HttpOnly/Strict cookie deployment, exact trusted-Origin approval and secure-context Web Locks. It serializes session mutations across same-origin tabs, keys hydration by session revision, performs at most one cookie refresh after `/me` expires, and surfaces unconfirmed server logout. It never persists tokens. See [audited frontend runtime](../../../docs/frontend-runtime.md) for actual browser evidence and limits; historical source assets are not the hardened implementation.

**What.** `lib/auth/AuthContext.tsx` (`AuthProvider`/`useAuth`) plus `app/login/page.tsx` and `app/register/page.tsx`. `AuthProvider` hydrates the current user by calling `GET /api/auth/me` on mount — the only way a client can know "am I logged in" when the access token lives in a cookie its JS can never read — and exposes `login`/`register`/`logout`/`refetch`. Wraps the app root in `AuthProvider` via a `modify` on `project.nextjs`'s marked `app/layout.tsx`.

**When.** After `frontend.nextjs` (needs `apiFetch`) and `authentication.password` (needs `/api/auth/register|login|me|logout` to exist on the backend).

**Requires.** `frontend.nextjs`, `authentication.password`.

**Configure via.** `redirectAfterLogin` (default `/`) — a bounded canonical internal path used with router replacement. External, protocol-relative, query/fragment and traversal redirects are rejected.

**Produces.** `files`: the three listed above, plus the `app/layout.tsx` wrap. `exports`: `AuthProvider`, `useAuth`. `routes`: `/login`, `/register` (Next.js file-based routes, not backend API routes).

**Connects to.** Downstream: `frontend.tables`/`frontend.dashboards` (any page that needs `useAuth()` to show/hide UI, or to know the current user's `id`/`role` for display).

**Test.** `npm test -- AuthContext` — mocks `apiFetch`; asserts `useAuth()` outside `AuthProvider` throws, and that a `GET /api/auth/me` 401 during hydration resolves to `user: null` (not an unhandled rejection).

**Validate.** All three files exist, `AuthContext.tsx` exports `AuthProvider`/`useAuth`, build passes.

**Security.** No token is ever stored client-side — see `frontend.nextjs`'s README. Register never auto-logs-in on success (the backend requires email verification first — don't shortcut it). **This context is a display convenience, not an authorization boundary** — hiding a button based on `user.role` client-side stops nothing; `authorization.rbac` on the backend is the actual enforcement. Treat every `useAuth()` read as "what should I show," never "is this allowed."
