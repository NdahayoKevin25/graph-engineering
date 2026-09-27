# api.webhooks

This audited node proposes a single generic inbound endpoint at
`POST /api/webhooks/inbound`. It deliberately defines its own HMAC-SHA256 v1
wire profile; it is **not** a verifier for arbitrary GitHub, Stripe, or other
provider signatures. A gateway or producer must explicitly implement this
profile. It does not install dependencies, call a provider, or process events.

Run after `project.node-express` and `backend.error-handler`. The renderer adds
one `src/routes/webhookRoutes.ts`, its test, a required `WEBHOOK_HMAC_SECRET`
declaration in the reviewed scaffold helpers, and a route mount after the
reviewed CORS/Helmet middleware but before Morgan and the global `express.json()`
parser. This prevents Morgan's URL token from logging webhook query strings.
Other methods at the endpoint receive an empty 405; unmatched paths under its
mount receive an empty 404. Neither falls through to Morgan. If `api.search`
already installed its audited Morgan skip guard, the renderer accepts only its
exact parsed shape with matching mounted search routes. Other middleware drift
and changed or partial scaffold markers fail closed. The secret must be 32
CSPRNG bytes encoded as 64 lowercase hex characters; generate it outside source control and never reuse the synthetic
test key. The route checks key shape and byte diversity, which does **not**
prove entropy or independent secret management.

The producer must send exactly one each of `X-Graph-Delivery-Id`,
`X-Graph-Timestamp`, and `X-Graph-Signature-256`. The ID is 1–128 ASCII
letters/digits plus `._:-` after its first alphanumeric character. The
timestamp is Unix seconds, at most five minutes old or one minute in the
future. The signature is lowercase `sha256=<64 hex>` for HMAC-SHA256 over the
UTF-8 prefix `graph-engineering/webhook-hmac-sha256/v1\n`, then the decimal
timestamp and `\n`, delivery ID and `\n`, decimal raw-body byte length and
`\n`, followed immediately by the exact raw body bytes.

The body must be an uncompressed `application/json` object, valid UTF-8, and
1–262,144 bytes. JSON is syntax-checked but no provider-specific event schema
is inferred. The route stores only verified raw bytes through an application
adapter, never trusting or logging the parsed payload.

The application must provide `src/services/webhookInbox.ts` exporting:

```ts
export async function enqueueVerifiedWebhook(input: {
  deliveryId: string;
  timestampSeconds: number;
  bodySha256: string;
  body: Buffer;
}): Promise<{ kind: 'inserted' | 'duplicate'; bodySha256: string }>;
```

This adapter must atomically insert by unique delivery ID or read the existing
digest. Return `inserted` only after durable commit; return `duplicate` with
the previously stored digest. Never replace a delivery's bytes, acknowledge an
uncommitted event, or process side effects outside an idempotent consumer.
The generated route returns 202 for a committed insertion or identical
duplicate, 409 for a conflicting duplicate, and a generic 503 if storage
fails or returns an invalid receipt. No sample memory-only adapter is emitted.
The renderer can verify the export and generated TypeScript, but cannot prove
the application's durable storage semantics. Review those and the event
consumer before deployment; this node makes no exactly-once claim.

Run `npm test -- webhookRoutes` and `npm run build` in the generated app.
The engine's separate offline fixture checks strict TypeScript, raw-body
ordering and generated security tests without a real provider or database.
