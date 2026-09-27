# storage.file-validation

## Executable runtime

The audited renderer customizes the already-bounded upload configuration, preserving multipart limits and sharing `MAX_SIZE_BYTES`/`ALLOWED_MIME_TYPES` with buffered uploads and presigned PUT generation. It accepts 1–16 unique canonical declared media types and a positive integer byte ceiling no greater than 10 MiB. Exactly Multer `2.4.0` is required, and edited prerequisite files are not silently overwritten.

This checks declared metadata only: it does not sniff content, scan malware or safely extract archives. See [audited storage runtime](../../../docs/storage-runtime.md). The historical description below predates the executable renderer's baseline limits.

## Historical catalog asset

**What.** `fileFilter` (MIME allowlist) + `MAX_SIZE_BYTES`, and a reconfigured `src/config/multer.config.ts` that wires both into `multer({ storage, limits: { fileSize }, fileFilter })` — replacing `storage.upload`'s bare, unbounded `upload` export.

**When.** After `storage.upload` (this node reconfigures its file), `backend.error-handler`. Required, not optional, for any upload endpoint reachable by untrusted users.

**Requires (extends).** `storage.upload`, `backend.error-handler`.

**Configure via.** `allowedMimeTypes` (default: png/jpeg/webp/pdf), `maxSizeBytes` (default 5 MiB).

**Produces.** `src/middlewares/fileValidation.ts`; replaces `src/config/multer.config.ts`'s `upload` export in place.

**Connects to.** Downstream: `backend.express` (routes get the validated `upload` automatically — no route-level change needed, since it's the same import path).

**Test.** `npm test -- fileValidation` — asserts `fileFilter` calls back with an error for a disallowed MIME type and accepts an allowed one.

**Security.** This is the single highest-value node in `storage/` — the reference app has no upload validation at all (REFERENCE_ARCHITECTURE.md §8). Three things to know:

1. MIME checking trusts the client-supplied `Content-Type` (`file.mimetype`) — it stops careless/accidental mismatches, not a deliberately spoofed header. A stricter threat model needs server-side magic-byte sniffing after upload, which this node does not implement (documented as a follow-up, not silently assumed).
2. Archive types (zip/gzip/tar/etc.) are excluded from the default allowlist — allowing them without a decompression-size guard opens a zip-bomb DoS vector.
3. `maxSizeBytes` is enforced via multer's own `limits.fileSize`, which rejects an oversized file while still streaming — never re-implement size checking by buffering the whole file first and checking `.length`, which defeats the purpose of the limit.
