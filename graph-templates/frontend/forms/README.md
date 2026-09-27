# frontend.forms

The audited runtime manages string-valued fields, synchronously blocks duplicate submissions, passes a frozen current-value snapshot and avoids updates after unmount. Unknown errors are redacted. It does not replace application/backend validation. See [audited frontend runtime](../../../docs/frontend-runtime.md); historical source assets are not the hardened implementation.

**What.** `useFormState<T>(initialValues)` — a generic hook managing form field values, per-field errors, an overall `formError` (populated from a caught `ApiError`'s `.message`), and `isSubmitting`. Returns `handleChange(field)` for simple `<input>` binding and `handleSubmit(onSubmit)` for wiring a real submit handler with error/loading handling done for you.

**When.** After `frontend.nextjs`. Used by any page with a form — `frontend.authentication`'s login/register pages could adopt it (they currently manage state inline for simplicity; this hook is for pages with more than 2-3 fields or repeated forms).

**Requires.** `frontend.nextjs` (catches `ApiError` from `apiFetch`).

**Produces.** `lib/forms/useFormState.ts` exporting `useFormState`, `FieldErrors<T>`, `UseFormStateResult<T>`.

**Connects to.** Downstream: any `frontend/*` page with a form, e.g. `frontend.dashboards`' settings/profile forms.

**Test.** `npm test -- useFormState` — asserts `setValue` updates `values` and clears that field's error, and `handleSubmit` sets `formError` to an `ApiError`'s message on rejection.

**Validate.** File exists, exports `useFormState`, build passes.

**Security.** This hook does not validate or send anything itself — it's state plumbing around whatever `onSubmit` the caller provides (which should call `apiFetch`). It never surfaces more of a caught error than `.message`, matching `backend.error-handler`'s discipline on the server side.
