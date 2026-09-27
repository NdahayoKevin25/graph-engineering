# frontend.tables

The audited runtime caps page size at 100 and filters at eight, bounds filter values, rejects reserved/prototype keys, aborts stale fetches and validates row/pagination envelopes. Ordinary cells are escaped primitive text, with unsupported nested values handled safely. See [audited frontend runtime](../../../docs/frontend-runtime.md); historical source assets are not the hardened implementation.

**What.** `useQueryTable<T>(basePath, pageSize?)` — fetches one page of a list endpoint, managing `page`/`sortBy`/`sortDir`/`filters` as URL query params in exactly the shape `backend.pagination`'s `parseListQuery` expects. `<DataTable>` is a thin presentational component consuming the hook's result — sortable headers, loading/empty states, prev/next pagination.

**When.** After `frontend.nextjs`. Pairs naturally with any entity `api.crud` generated on the backend (the hook's query-param shape is exactly what `api.crud`'s `findMany` patch reads).

**Requires.** `frontend.nextjs`.

**Configure via.** `defaultPageSize` (default 20 — matches `backend.pagination`'s own default).

**Produces.** `lib/tables/useQueryTable.ts` (`useQueryTable`, `UseQueryTableResult<T>`, `SortDir`) and `components/DataTable.tsx` (`DataTable`, `Column<T>`).

**Connects to.** Downstream: any list page — see `frontend.dashboards` for a worked composition, or use directly: `const table = useQueryTable<Product>('/api/products'); <DataTable table={table} columns={[...]} getRowId={(p) => p.id} />`.

**Test.** `npm test -- useQueryTable` — mocks `apiFetch`; asserts a page-size query param is always sent, and clicking the same sortable column twice flips `sortDir` rather than resetting it.

**Validate.** Both files exist, `useQueryTable` is exported, build passes.

**Security.** Client-side field syntax and resource bounds do not replace `api.crud`'s server-side filter/sort/row authorization. These components only display returned data; hidden UI is not an access-control boundary. Application-specific row schemas and trusted custom cell renderers require review. Pagination metadata is checked for consistency before publication.
