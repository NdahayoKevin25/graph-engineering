# storage.presigned-url

## Executable runtime

Use `new PresignedUrl(authorize)`. `getUploadUrl(principal, contentType, size, expiry?)` creates a fresh scoped key and returns `{url,key,headers,expiresIn}`; the exact size, type and conditional-write headers are signed and must be transmitted. `getDownloadUrl(principal, key, expiry?)` scopes and authorizes before signing. Both require finite bounded expiry; uploads share `storage.upload`'s configured limits. This hardened node therefore requires the upload configuration in addition to `storage.aws-s3`.

The real offline SDK signer is tested, but provider-side enforcement and browser compatibility are not live-verified. URLs are bearer credentials; a default SDK empty-body checksum is deliberately avoided when signing unknown future bytes. See [audited storage runtime](../../../docs/storage-runtime.md). The historical asset below is not the supported API.

## Historical catalog asset

**What.** `PresignedUrl.getUploadUrl(key, contentType, expiresIn?)` and `PresignedUrl.getDownloadUrl(key, expiresIn?)` — time-limited signed URLs (default 3600s, hard-capped at `maxExpirySeconds`). `getDownloadUrl` ports the reference app's existing `FileUpload.getSignedUrl` verbatim; `getUploadUrl` is new, giving clients a way to upload directly to storage without routing the file bytes through the API server.

**Scope note.** The original project brief asked for "presigned upload" and "presigned download" as separate templates — they're deliberately consolidated here into one node, since both are the identical `getSignedUrl(command, { expiresIn })` call differing only in which S3 command they sign.

**When.** After `storage.aws-s3`. Before whichever `backend.express` route hands a client one of these URLs.

**Requires.** `storage.aws-s3`.

**Configure via.** `defaultExpirySeconds` (3600), `maxExpirySeconds` (86400 — hard cap regardless of what a caller requests).

**Produces.** `src/repository/PresignedUrl.ts` exporting `PresignedUrl`.

**Test.** `npm test -- presignedUrl` — asserts a requested `expiresIn` above `maxExpirySeconds` is clamped, not honored.

**Security.** Expiry is always server-clamped — an unbounded presigned URL is a permanent public link to a private object. A presigned upload URL should always target a freshly randomized key (same convention as `storage.upload`), never a caller-chosen one, or a malicious caller could overwrite another object. Treat the URL itself as a bearer credential — don't log it at INFO level.
