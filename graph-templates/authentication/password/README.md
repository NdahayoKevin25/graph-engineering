# authentication.password

The engine now provides an audited deterministic Password authentication renderer. Its
credential, identity, cookie, concurrency and authorization contract is documented
in [the executable authentication guide](../../../docs/authentication-runtime.md).
That runtime emits reviewed source and tests; it does not execute the historical
prompt/asset snippets below, configure secrets, deliver email, or authorize a
deployment automatically. Existing custom code requires explicit reconciliation.

**What.** The reference app's full auth feature — register, login, logout, forgot-password, reset-password, verify-email — restructured through `Authentication` repository → `authenticationService` → `authenticationController` → `authenticationRoutes` (mounted at `/api/auth`), instead of the original's service-coupled-to-`(req,res)` pattern. Also adds `GET /api/auth/me` (authenticated) — not present in the reference app, but a hard requirement for any client that can't read the httpOnly `access_token` cookie itself (see `frontend.authentication`, which is this endpoint's first real consumer) to answer "am I logged in, and as whom."

**When.** After `authentication.jwt` (token issuance), `database.neon-postgres.connection` (schema/connection), `backend.error-handler`/`backend.validation`/`backend.api-response`/`backend.middleware`.

**Requires.** All six listed above.

**Configure via.** `minPasswordLength` (default 12, matches the reference app).

**Produces.** `files`: repository/service/controller/route + appended `schema.ts` tables (`users`, `user_profiles`, `auth_tokens`) + `SALT_ROUNDS` in `SECRETS` + mounted `/api/auth` routes. Also upgrades `authentication.jwt`'s `authMiddleware` in place (`files.modify`, `replace-method`) to re-load the user by id and reject if deleted or `status !== 'active'` — see `authentication.jwt`'s README for why this only becomes possible once this node's `users` table exists.

**Connects to.** Downstream: `authorization.rbac`/`authorization.tenant-isolation` (read `req.user.role`/`id` this flow ultimately sets via `authentication.jwt`'s cookie).

**Test.** `npm test -- authentication` — supertest against `/api/auth/register`→`/login`→`/logout`, and asserts `forgotPassword` returns the identical message for both an existing and non-existent email.

**Validate.** Repository file exists, `/api/auth` is mounted, build passes.

**Security.** `forgotPassword` is constant-response by design — ported verbatim, never make it account-existence-specific. Verification/reset tokens: random 32 bytes, SHA-256-hashed before storage, single-use (`consumedAt`), never logged. Passwords: bcrypt, `SALT_ROUNDS >= 10` (floor enforced), minimum length 12. Login sets both `access_token` and `refresh_token` as `httpOnly`/`sameSite=lax`/`secure`-in-production cookies — never in the JSON body — and persists the refresh token's hash to `authentication.jwt`'s `refresh_tokens` table (login is a second writer to that table alongside `POST /api/auth/refresh`'s rotation). `logout` revokes the presented refresh token server-side (sets `revokedAt`) before clearing cookies, rather than only clearing cookies client-side — a copied-but-not-yet-used refresh token stops working immediately on logout instead of silently remaining valid until it expires.

**Why the layering changed vs. the reference app.** The original `authService.ts` takes `(req, res)` directly. This node's `authenticationService.ts` takes/returns plain data (`register(data)`, `login(email, password)`, etc.) — testable without mocking Express, and reusable if a later node needs to trigger registration from somewhere that isn't an HTTP request (e.g. an admin-invite flow).
