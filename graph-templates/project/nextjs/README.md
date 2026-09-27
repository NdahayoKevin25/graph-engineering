# project.nextjs

**What.** The audited renderer scaffolds a separate pinned Next.js 16.3.5 / React 19.3.0 TypeScript App Router project: package/config files, root layout/home page, tests and a validated public API origin. It uses a reviewed code default when `NEXT_PUBLIC_API_URL` is empty or unset. See [audited frontend runtime](../../../docs/frontend-runtime.md) for exact policy, dependency and deployment requirements. Historical `files/` assets are not the hardened executable renderer.

**When.** First node in a Next.js frontend graph. Its downstream Next.js nodes modify or add to files this node creates, the same way `backend/*` nodes build on `project.node-express`. A Vite frontend uses `project.vite-react` instead.

**Requires.** This is a root node independent of `project.node-express`. Root rendering requires explicit permission for the public `.graph/manifest.json` ledger and only `.env.example`; private context and real environment files stay excluded. Dependency installation/locking is a separate reviewed workflow, never a renderer hook.

**Configure via.** `projectName` (required), `description`, `port` (default `3001` — offset from `project.node-express`'s `3000` so both dev servers can run at once), `apiBaseUrl` (default `http://localhost:3000`).

**Produces.** `files` (see `template.yaml`), `entrypoint: app/layout.tsx`.

**Connects to.** Downstream: `frontend.nextjs` (API client), `frontend.authentication`, `frontend.forms`, `frontend.tables`, `frontend.dashboards`. `app/layout.tsx` carries two marker comments (import line, `{children}` wrap point) that `frontend.authentication`'s `modify` action uses to wrap the tree in `<AuthProvider>` — never regenerate `app/layout.tsx` after that node has run; only `modify`.

**Validate.** `package.json` and `app/layout.tsx` exist; `npm run build` passes.

**Test.** `npm test -- HomePage` — a smoke test rendering the home page (`vitest` + `jsdom` + React Testing Library, configured by `vitest.config.ts`/`vitest.setup.ts` this node also creates — every `frontend/*` node's component tests reuse this same config).

**Security.** `NEXT_PUBLIC_*` values are public client configuration, never secrets. Authentication uses backend HttpOnly cookies, not browser token storage. The audited backend uses `SameSite=Strict` and exact trusted-Origin checks: deploy frontend/API same-site and explicitly configure credentialed CORS when origins differ. Different-origin is not the same as cross-site, and switching to Lax does not authorize cross-site fetch. No CORS, provider or production origin is automatically approved. Browser authentication requires secure-context Web Locks; see the runtime documentation.
