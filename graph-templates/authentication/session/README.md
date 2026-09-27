# authentication.session

The engine provides an audited deterministic renderer for this node. It reads
the reviewed sources in `files/` and `tests/`, refuses to render if any of them
differs from the reviewed content, substitutes only the two timeout inputs, and
proposes the result as a reviewable change. It never installs packages, runs a
migration or configures secrets. See also
[the executable authentication guide](../../../docs/authentication-runtime.md).

**What.** Server-side session authentication. The browser holds only an opaque
session id in an httpOnly cookie; the session record lives in a server-side
`SessionStore`. Every authenticated request looks the session up, enforces its
idle and absolute timeouts, and re-resolves the current account, so a session
can be revoked instantly.

**When.** After `authentication.password` (which composes `authentication.jwt`,
`backend.error-handler`, `backend.middleware` and the Drizzle schema). Choose
this node when instant server-side revocation is a hard requirement; otherwise
`authentication.jwt` avoids a store lookup per request.

**Requires.** The applied password node: `AuthenticationRepository` (bcrypt
hashing and comparison) in `src/repository/Authentication.ts`,
`resolveAuthenticationIdentity` in `src/services/authIdentity.ts`, `userTable`
in `src/config/schema.ts`, and the `req.user` declaration in
`src/middlewares/authMiddleware.ts`. The application must declare `express` 4,
`zod`, `drizzle-orm`, `cookie-parser`, `vitest` and `supertest`, plus the exact
`bcrypt: "6.0.0"` and `jsonwebtoken: "9.0.3"` pins the password node requires.
No new package is needed: sessions use `node:crypto` and Express.

**Configure via.** Inputs `idleTimeout` (default `30m`) and `absoluteTimeout`
(default `12h`), with explicit `s`/`m`/`h`/`d` units: idle 1 minute to 24 hours,
absolute 1 hour to 30 days, idle not longer than absolute. Environment:

| Variable                           | Required | Meaning                                                                                                                   |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`                   | yes      | HMAC key for store lookup keys. **No default.** At least 32 bytes of random material, e.g. `openssl rand -base64 48`, and different from `ACCESS_TOKEN_SECRET`/`REFRESH_TOKEN_SECRET`. |
| `SESSION_STORE`                    | no       | `memory` (default, development only), `postgres`, or `custom`.                                                            |
| `SESSION_IDLE_TIMEOUT_SECONDS`     | no       | 60–86400; overrides the rendered idle timeout.                                                                            |
| `SESSION_ABSOLUTE_TIMEOUT_SECONDS` | no       | 3600–2592000; overrides the rendered absolute lifetime.                                                                   |
| `SESSION_COOKIE_SECURE`            | no       | `true` by default. `false` only for local HTTP development; refused when `NODE_ENV=production`.                           |

**Produces.**

- `src/sessions/sessionStore.ts`: the `SessionStore` interface
  (`get`/`set`/`destroy`/`touch`/`destroyAllForUser`/`prune`,
  `productionReady`), the development `MemorySessionStore`, and
  `createMemorySessionStore`, which logs a loud warning and refuses
  `NODE_ENV=production`.
- `src/sessions/postgresSessionStore.ts`: `PostgresSessionStore` on the existing
  Drizzle `database` connection.
- `src/sessions/session.ts`: `loadSession`, `requireSession`, `csrfProtection`,
  `startSession`, `regenerateSession`, `destroySession`, `revokeSession`,
  `revokeUserSessions`, `pruneExpiredSessions`, `configureSessionStore` and
  configuration validation.
- `src/routes/sessionRoutes.ts`, mounted at `/api/session`:
  `POST /login`, `GET /me`, `GET /csrf`, `POST /logout`, `POST /logout-all`.
- A `sessions` table appended to `src/config/schema.ts` (generate and review the
  migration separately), `SESSION_SECRET` in `SECRETS` and
  `requiredEnvironmentVariables`, and `tests/authenticationSession.test.ts`.
- Reviewed edits to the password node's reset path: the reset transaction in
  `src/repository/Authentication.ts` deletes the account's sessions when
  `SESSION_STORE=postgres`, and `resetPassword` in
  `src/services/authenticationService.ts` calls `revokeUserSessions` after the
  reset commits, for every store. Re-rendering `authentication.password` over
  these edits reports a conflict; reconcile explicitly.

**Connects to.** Protect application routes with the exported middleware.
`requireSession` sets `req.user`, so `authorization.rbac`'s `requireRole` works
unchanged:

```ts
router.delete('/:id', requireSession, csrfProtection, requireRole('admin'), asyncHandler(controller.remove));
```

A browser client logs in with `credentials: "include"`, keeps the `csrfToken`
from the login response (or `GET /api/session/csrf`) in memory, and sends it as
`X-CSRF-Token` on every POST, PUT, PATCH and DELETE.

**Plugging in Redis or another store.** Implement `SessionStore` with
`productionReady = true`, set `SESSION_STORE=custom`, and call
`configureSessionStore(store)` before the server accepts requests. Requests fail
closed until a store is configured. Store keys are already HMAC digests; give
records a TTL no shorter than the absolute timeout. `destroy` must be atomic and
resolve `true` only for the call that removed the record (Redis `DEL` returning
1), `prune` must be bounded by its limit, and `set`/`destroy` may ignore the
`transaction` argument, which only a PostgreSQL store can join.

**Expired sessions.** `pruneExpiredSessions(limit = 500)` deletes idle-expired
and absolute-expired sessions in one bounded batch and resolves the count; run
it from a scheduled job to observe failures. Login also runs it in the
background at most once a minute per process.

**Reverse proxies.** The login limiter keys on `req.ip`. Behind a load balancer
or reverse proxy, set `app.set('trust proxy', <exact hop count or proxy
addresses>)` so `req.ip` is the client address; without it every client shares
one bucket, and `trust proxy: true` lets clients spoof `X-Forwarded-For`.

**Test.** `npm test -- authenticationSession`, with `SESSION_SECRET` and the
other required variables set. It uses real bcrypt, real HTTP and the memory
store, and replaces only the account database lookup.

**Security.**

- Ids are 32 bytes from `node:crypto` `randomBytes` (256 bits), base64url in the
  cookie. The store is keyed by `HMAC-SHA256(SESSION_SECRET, id)`; the raw id is
  never stored or returned in a response body.
- The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/` and `Secure`, named
  `__Host-sid` so browsers also reject it without Secure or with a Domain.
  Behind a TLS-terminating proxy, keep the default; the cookie is marked Secure
  regardless of `req.secure`.
- Login takes the same per-account PostgreSQL advisory lock as JWT login,
  refresh and password reset, re-reads the password hash inside that
  transaction, and writes a PostgreSQL session inside it. A reset therefore
  either commits first (and the old password fails) or waits and then revokes
  the new session. A password reset revokes every session of the account; the
  password node has no separate password-change endpoint, so call
  `revokeUserSessions()` from any you add.
- Login destroys any session presented with the request and issues a new id.
  When the resolved account role differs from the role the session was issued
  with, the next request rotates the id and CSRF token and destroys the old
  record, without extending the absolute deadline. A replacement is minted only
  if that atomic delete removed the old record, so a concurrent logout,
  revocation or second rotation never resurrects or duplicates a session. Call
  `regenerateSession()`
  yourself after other privilege changes, and `revokeUserSessions()` after a
  password change or suspected compromise.
- Idle and absolute timeouts are checked server-side on every request. Expired,
  unknown or malformed sessions are destroyed and the cookie cleared.
- Suspended, deleted or unverified accounts lose their sessions on the next
  request, because the account is re-resolved each time.
- `csrfProtection` requires the per-session synchronizer token for every method
  except GET, HEAD and OPTIONS, compared with `timingSafeEqual` over SHA-256
  digests. Login has no session yet, so it requires an exact trusted `Origin`
  from `CORS_ORIGIN` instead. SameSite=Lax is defence in depth, not the CSRF
  control. Keep safe methods free of side effects.
- Login uses the password node's bcrypt repository, compares against a real
  dummy hash for unknown accounts, answers every credential failure with the
  same `Invalid credentials` message, and never logs request bodies. Timing is
  not guaranteed identical end to end. The login limiter is per process, not a
  distributed abuse-prevention service; when its table is full it evicts the
  oldest windows instead of refusing new addresses.
- The memory store loses sessions on restart, is not shared between processes,
  and is refused under `NODE_ENV=production`.
- This node does not remove the JWT routes that `authentication.password`
  mounts at `/api/auth`. Use one browser session mechanism per application and
  disable the other.
