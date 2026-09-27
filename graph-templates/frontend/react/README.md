# frontend.react

The audited `frontend.react` renderer adds the same hardened typed API client
used by `frontend.nextjs` to a reviewed `project.vite-react` root. The client
imports `ENV.API_URL` from the root's `lib/env.ts` and emits
`lib/apiClient.ts` plus a generated test. Its bounded `/api/` paths, included
credentials, constant safe errors, response limits and deadline are described
in the [frontend runtime](../../../docs/frontend-runtime.md). The catalog
`files/` directory is descriptive; the deterministic renderer is executable.

This node does not provide login/register pages, a router, forms, tables or a
dashboard. Those existing catalog nodes have exact `frontend.nextjs` or
Next.js layout prerequisites and are not advertised as Vite-compatible.
Applications must supply their own reviewed routes and backend access checks.

The API origin is public build-time configuration. Cookie-authenticated API
requests require same-site frontend/API deployment plus exact credentialed
CORS and trusted-Origin approval when their origins differ. No browser token
storage or automatic application authorization is generated.
