# frontend.dashboards

The audited renderer emits `components/Dashboard.tsx` and `tests/Dashboard.test.tsx`. It composes the exact reviewed `frontend.authentication`, `frontend.tables` and `frontend.forms` outputs; edited upstream files require explicit reconciliation. There are no node inputs, generated routes, network calls, installed packages or migrations.

Use `Dashboard` inside an application-owned Next page that is already wrapped in `AuthProvider`. Pass a title, optional internal navigation with explicit `customer`/`admin` display roles, optional statistics, and optionally a table configuration (`basePath`, columns and row ID) and `onSaveProfile` callback. The table mounts only after the auth context reports a user. No table path, statistics API or profile-save endpoint is chosen by this node. The callback must use a separately reviewed backend route, validation and authorization; do not display secret values in stats.

For example, an application could supply `table={{heading:'Products',basePath:'/api/products',columns:[{key:'name',label:'Name'}],getRowId:(row)=>row.id}}` after approving that API's row schema and access rules. Without a configured table or callback, those sections are absent; the component does not fabricate data or report a save that never occurred.

The navigation filter and signed-out view are UI conveniences, **not authorization**. Backend authentication, role checks, row scoping and update permissions remain authoritative even when a link is hidden. Role-allowed links are bounded to local paths; user-supplied text is rendered as React text. Custom column renderers and callbacks are trusted application code and need review. The preexisting `apiFetch`/table bounds remain in force.

The generated test checks signed-out no-fetch behavior, admin/customer navigation, text-rendered stats and table composition, and profile callback wiring. Strict generated-app typecheck, unit tests and production build are exercised by the opt-in offline frontend container suite; its browser tests cover the existing authentication/table integration, not a deployed dashboard page. See [audited frontend runtime](../../../docs/frontend-runtime.md).
