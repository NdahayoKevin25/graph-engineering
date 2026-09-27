# storage.delete

## Executable runtime

The audited renderer adds `new FileUpload(authorize).deleteFile(principal, key)` only to the exact reviewed upload implementation. Canonical key ownership and an explicit `delete` authorization decision are checked before SDK transport. Failures use a constant 502 error without logging provider details. Recovery depends on provider versioning/lifecycle configuration; the renderer does not provision backups or a trash mechanism.

See [audited storage runtime](../../../docs/storage-runtime.md). The historical asset below is not the supported executable API; its absence-of-ownership-check statement does not describe the audited renderer.

## Historical catalog asset

**What.** Appends `deleteFile(key)` to `storage.upload`'s `FileUpload` class (via `DeleteObjectCommand`), throwing `APIError(502)` on failure — the same throw-not-swallow discipline `storage.upload` already applies to uploads. Also inserts an `import { DeleteObjectCommand } from '@aws-sdk/client-s3';` line into `FileUpload.ts`'s existing import block (do this as part of the same `modify` action).

**When.** After `storage.upload` (modifies its file), `backend.error-handler`.

**Requires.** `storage.upload`, `backend.error-handler`.

**Produces.** `src/repository/FileUpload.ts`, modified — adds `deleteFile` alongside the existing `uploadFileToS3`.

**Connects to.** Downstream: `backend.express`, `authorization.rbac` (a delete route should almost always be role/ownership-gated).

**Test.** `npm test -- delete` — mocks `s3Client.send` to reject, asserts `deleteFile` throws `APIError`.

**Security.** Same key-provenance rule as `storage.download`: `key` must come from a trusted, already-authorization-checked source, never raw client input — an unchecked `deleteFile` is an arbitrary-object-deletion vulnerability. This node performs no ownership check itself. Deletion is irreversible (no default S3 trash); if recoverability matters, soft-delete the owning database row first and only call `deleteFile` from a separate cleanup path, or enable bucket versioning at the infrastructure level.
