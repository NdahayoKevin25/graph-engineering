import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import express, { Request } from 'express';
import { APIError } from '../middlewares/errorMiddleware';
import { enqueueVerifiedWebhook } from '../services/webhookInbox';
import { SECRETS } from '../utils/helpers';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_AGE_SECONDS = 300;
const MAX_FUTURE_SECONDS = 60;
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMESTAMP = /^[1-9][0-9]{9,11}$/;
const SIGNATURE = /^sha256=([a-f0-9]{64})$/;
const SECRET = /^[a-f0-9]{64}$/;
const DOMAIN = 'graph-engineering/webhook-hmac-sha256/v1';

function oneHeader(req: Request, name: string): string | null {
  let value: string | null = null;
  for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() !== name) continue;
    if (value !== null) return null;
    value = req.rawHeaders[index + 1];
  }
  return value;
}

function signingKey(): Buffer | null {
  const value = SECRETS.WEBHOOK_HMAC_SECRET;
  if (typeof value !== 'string' || !SECRET.test(value)) return null;
  const key = Buffer.from(value, 'hex');
  // Shape and byte diversity reject obvious placeholders; only the operator
  // can attest that a CSPRNG generated this secret independently.
  if (key.length !== 32 || new Set(key).size < 16) {
    key.fill(0);
    return null;
  }
  return key;
}

/** Exact, fixed wire profile; not a verifier for arbitrary providers. */
export function verifyWebhookSignature(
  key: Buffer,
  rawBody: Buffer,
  deliveryId: string,
  timestamp: string,
  signature: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const match = typeof signature === 'string' ? SIGNATURE.exec(signature) : null;
  if (
    !Buffer.isBuffer(key) || key.length !== 32 ||
    !Buffer.isBuffer(rawBody) || rawBody.length < 1 || rawBody.length > MAX_BODY_BYTES ||
    typeof deliveryId !== 'string' || !DELIVERY_ID.test(deliveryId) ||
    typeof timestamp !== 'string' || !TIMESTAMP.test(timestamp) || !match ||
    !Number.isSafeInteger(nowSeconds) ||
    Number(timestamp) < nowSeconds - MAX_AGE_SECONDS ||
    Number(timestamp) > nowSeconds + MAX_FUTURE_SECONDS
  ) return false;
  const frame = `${DOMAIN}\n${timestamp}\n${deliveryId}\n${rawBody.length}\n`;
  const expected = createHmac('sha256', key).update(frame).update(rawBody).digest();
  const supplied = Buffer.from(match[1], 'hex');
  try {
    return timingSafeEqual(expected, supplied);
  } finally {
    expected.fill(0);
    supplied.fill(0);
  }
}

export const webhookRoutes = express.Router();
webhookRoutes.post(
  '/',
  express.raw({ type: 'application/json', limit: MAX_BODY_BYTES, inflate: false }),
  async (req, res, next): Promise<void> => {
    const contentType = oneHeader(req, 'content-type');
    if (!contentType || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType)) {
      next(new APIError('Unsupported webhook content type', 415));
      return;
    }
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody) || rawBody.length < 1 || rawBody.length > MAX_BODY_BYTES) {
      next(new APIError('Invalid webhook body', 400));
      return;
    }
    const key = signingKey();
    if (!key) {
      next(new APIError('Webhook unavailable', 503));
      return;
    }
    const deliveryId = oneHeader(req, 'x-graph-delivery-id');
    const timestamp = oneHeader(req, 'x-graph-timestamp');
    const signature = oneHeader(req, 'x-graph-signature-256');
    let verified = false;
    try {
      verified = verifyWebhookSignature(key, rawBody, deliveryId ?? '', timestamp ?? '', signature ?? '');
    } finally {
      key.fill(0);
    }
    if (!verified) {
      next(new APIError('Invalid webhook', 401));
      return;
    }
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
      const payload: unknown = JSON.parse(decoded);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new Error('Webhook JSON object required');
    } catch {
      next(new APIError('Invalid webhook body', 400));
      return;
    }
    const bodySha256 = createHash('sha256').update(rawBody).digest('hex');
    let stored: { kind: 'inserted' | 'duplicate'; bodySha256: string };
    try {
      stored = await enqueueVerifiedWebhook({
        deliveryId: deliveryId!,
        timestampSeconds: Number(timestamp),
        bodySha256,
        body: Buffer.from(rawBody),
      });
    } catch {
      next(new APIError('Webhook unavailable', 503));
      return;
    }
    if (
      !stored ||
      (stored.kind !== 'inserted' && stored.kind !== 'duplicate') ||
      typeof stored.bodySha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(stored.bodySha256)
    ) {
      next(new APIError('Webhook unavailable', 503));
      return;
    }
    if (stored.bodySha256 !== bodySha256) {
      next(new APIError(stored.kind === 'duplicate' ? 'Webhook delivery conflict' : 'Webhook unavailable', stored.kind === 'duplicate' ? 409 : 503));
      return;
    }
    res.status(202).json({ accepted: true });
  },
);

// Do not let other methods or paths under this mount fall through to a later
// access logger, which might include a query string in its URL token.
webhookRoutes.all('/', (_req, res) => {
  res.status(405).end();
});
webhookRoutes.use((_req, res) => {
  res.status(404).end();
});
