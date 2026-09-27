# project.vite-react

The audited renderer creates a separate client-rendered Vite 7.3.6 / React
19.3.0 / TypeScript 5.9.3 project. Its reviewed application entrypoint is
`src/main.tsx`; it also emits an app test, strict build and test configuration,
and a public API origin helper. The catalog `files/` directory documents the
file contract; the deterministic engine renderer is the executable source.

Use this root before `frontend.react`, the typed API client. The root does not
add a router, authentication pages, forms, tables or dashboard wiring. Those
existing graph nodes have Next.js-specific prerequisites and are not declared
compatible with this root.

Inputs are `projectName` (required), optional `description`, `port` (default
3001), and `apiBaseUrl` (default `http://localhost:3000`). The API origin must
be HTTPS or explicit loopback HTTP, without credentials, path, query or fragment.
The optional public `VITE_API_URL` override is embedded at build time; an empty
value uses the reviewed code default. Never place secrets in `VITE_` variables.
The development and preview servers bind `localhost`, matching the default API
hostname so strict cookies remain same-site during local development.

Root rendering requires explicit policy permission for the public
`.graph/manifest.json` ledger and `.env.example` only. It emits proposals; it
does not install packages or create a lockfile. Provision a reviewed lockfile
before running generated code. Divergent existing outputs require explicit
reconciliation. The app and API need same-site deployment for the backend's
strict cookies and exact credentialed CORS/trusted-Origin approval when origins
differ. This scaffold does not configure deployment or backend authorization.

After dependency provisioning, use `npm run typecheck`, `npm test`, and
`npm run build` to verify the generated app. See the
[frontend runtime](../../../docs/frontend-runtime.md) for the audited boundary.
