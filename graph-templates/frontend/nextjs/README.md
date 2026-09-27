# frontend.nextjs

**What.** The audited `apiFetch<T>(path, options?)` uses bounded `/api/...` paths at the configured origin, included credentials, no redirects/cache, bounded JSON bodies/responses and a 15-second deadline. It returns the complete parsed envelope. Errors use safe constant messages and actual HTTP status, never raw response bodies. See [audited frontend runtime](../../../docs/frontend-runtime.md); historical catalog assets are not the executable implementation.

**When.** After `project.nextjs`. Before `frontend.authentication`, `frontend.tables`, `frontend.forms`, `frontend.dashboards` — all of them import `apiFetch`.

**Requires.** `project.nextjs` (imports its `lib/env.ts`).

**Produces.** `lib/apiClient.ts` exporting `apiFetch`, `ApiError`, `ApiSuccess<T>`, `ApiPaginated<T>`, `PaginationMeta`.

**Connects to.** Downstream: every other `frontend/*` node. Upstream, its response shapes are a direct mirror of `backend.api-response`/`backend.error-handler`/`backend.pagination` on the Express side — if those envelopes ever change shape, this file must change with them (there is no schema-driven codegen here yet; see `ai.api-agent`'s note about `api.schema.json` as the intended source of truth for a future stricter client).

**Test.** The emitted API-path test and offline fixture exercise real Response streams with mocked fetch: origin/redirect boundaries, request/response limits, safe status errors, malformed JSON and cancellation.

**Validate.** File exists, exports `apiFetch`/`ApiError`, build passes.

**Security.** Caller options cannot override headers, credentials or redirects. The authentication provider may perform one bounded cookie-only refresh after `/me` returns 401; it never reads a token or automatically retries arbitrary writes. Network/CORS failures are status 0, not fabricated authentication failures. Same-site deployment and backend authorization remain required.
