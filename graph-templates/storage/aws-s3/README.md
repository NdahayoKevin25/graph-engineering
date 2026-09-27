# storage.aws-s3

## Executable runtime

The audited renderer emits `s3Client`, `storageBucket`, a shared scoped authorization policy and an emitted scope test, and updates the scaffold's environment helper. It requires an administrator-controlled HTTPS endpoint and explicit credentials. It does not inspect or configure bucket/IAM privacy. Malformed configuration errors are redacted.

Use the [audited storage runtime documentation](../../../docs/storage-runtime.md) for the supported APIs, pinned verification fixture and deployment responsibilities. The catalog assets described below are historical source examples, not the hardened runtime implementation; compatibility with individual S3 providers has not been live-verified.

## Historical catalog asset

**What.** `s3Client` (an S3-_compatible_ `@aws-sdk/client-s3` client — works against real AWS, Neon Object Storage, Cloudflare R2, or MinIO, not just AWS) and `storageBucket`, ported from the reference app's `s3-client.ts`. `forcePathStyle: true` and an explicit `AWS_ENDPOINT_URL_S3` are what make it compatible beyond AWS.

**When.** After `project.node-express`. Before any of `storage.upload`/`storage.download`/`storage.presigned-url`/`storage.delete`, which all import `s3Client`/`storageBucket` from this node's output.

**Requires.** `project.node-express`.

**Configure via.** `defaultBucketName` (default `'media'`, matching the reference app) — used only when `AWS_BUCKET_NAME` is unset.

**Produces.** `src/config/s3-client.ts` exporting `s3Client`, `storageBucket`. Adds `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (required) and `AWS_BUCKET_NAME` (optional) to `SECRETS`.

**Connects to.** Downstream: every other `storage.*` node.

**Test.** `npm test -- s3-client` — asserts the client is constructed with `forcePathStyle: true` and the configured endpoint/region.

**Security.** Bucket access is private by default — nothing here grants public read. All four core credentials are required with no silent fallback (fail fast at boot, same discipline as the rest of `SECRETS`). Never special-case AWS-only features; keep the client provider-agnostic since this is the whole point of the S3-compatible endpoint design.
