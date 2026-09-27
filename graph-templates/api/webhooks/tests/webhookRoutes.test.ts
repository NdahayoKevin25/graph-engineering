import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import express from 'express';
import morgan from 'morgan';
import request from 'supertest';

const fixture = vi.hoisted(() => ({
  keyHex: Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join(''),
  enqueueVerifiedWebhook: vi.fn(),
}));
const secret = Buffer.from(fixture.keyHex, 'hex');
vi.mock('../src/utils/helpers', () => ({ SECRETS: { WEBHOOK_HMAC_SECRET: fixture.keyHex } }));
vi.mock('../src/services/webhookInbox', () => ({ enqueueVerifiedWebhook: fixture.enqueueVerifiedWebhook }));

import { webhookRoutes, verifyWebhookSignature } from '../src/routes/webhookRoutes';
import { errorHandler } from '../src/middlewares/errorMiddleware';

const app = express();
const logged: string[] = [];
app.use('/api/webhooks/inbound', webhookRoutes);
app.use(morgan('dev', { stream: { write: (line: string) => { logged.push(line); } } }));
app.use(express.json());
app.use(errorHandler);
const domain = 'graph-engineering/webhook-hmac-sha256/v1';
const validBody = '{"kind":"example","value":1}';
const now = () => String(Math.floor(Date.now() / 1000));

function signature(body: string, deliveryId: string, timestamp: string): string {
  const raw = Buffer.from(body, 'utf8');
  return 'sha256=' + createHmac('sha256', secret)
    .update(`${domain}\n${timestamp}\n${deliveryId}\n${raw.length}\n`)
    .update(raw).digest('hex');
}

function post(body = validBody, deliveryId = 'delivery-1', timestamp = now()) {
  return request(app).post('/api/webhooks/inbound')
    .set('content-type', 'application/json')
    .set('x-graph-delivery-id', deliveryId)
    .set('x-graph-timestamp', timestamp)
    .set('x-graph-signature-256', signature(body, deliveryId, timestamp))
    .send(body);
}

beforeEach(() => {
  logged.length = 0;
  fixture.enqueueVerifiedWebhook.mockReset();
  fixture.enqueueVerifiedWebhook.mockImplementation(async ({ bodySha256 }: { bodySha256: string }) => ({ kind: 'inserted', bodySha256 }));
});

describe('fixed generic HMAC webhook ingress', () => {
  it('terminates non-POST and unmatched webhook-prefix traffic before the access logger', async () => {
    const wrongMethod = await request(app).get('/api/webhooks/inbound?probe=PRIVATE_QUERY_CANARY');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.text).toBe('');
    const wrongSubpath = await request(app).get('/api/webhooks/inbound/other?probe=PRIVATE_QUERY_CANARY');
    expect(wrongSubpath.status).toBe(404);
    expect(wrongSubpath.text).toBe('');
    expect(logged).toEqual([]);
    expect(fixture.enqueueVerifiedWebhook).not.toHaveBeenCalled();
  });

  it('accepts only an exact raw-body MAC and forwards the verified bytes to the inbox', async () => {
    const response = await post();
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: true });
    expect(fixture.enqueueVerifiedWebhook).toHaveBeenCalledTimes(1);
    const input = fixture.enqueueVerifiedWebhook.mock.calls[0][0];
    expect(input.deliveryId).toBe('delivery-1');
    expect(input.body).toEqual(Buffer.from(validBody));
    expect(input.bodySha256).toBe(createHash('sha256').update(validBody).digest('hex'));
    expect(verifyWebhookSignature(secret, Buffer.from(validBody), 'delivery-1', now(), 'sha256=' + '0'.repeat(64))).toBe(false);
  });

  it('rejects altered body, delivery ID, timestamp, malformed signature and stale replay before inbox', async () => {
    const timestamp = now();
    const signed = signature(validBody, 'delivery-1', timestamp);
    const altered = await request(app).post('/api/webhooks/inbound')
      .set('content-type', 'application/json')
      .set('x-graph-delivery-id', 'delivery-1')
      .set('x-graph-timestamp', timestamp)
      .set('x-graph-signature-256', signed)
      .send('{"kind":"changed"}');
    expect(altered.status).toBe(401);
    const wrongId = await request(app).post('/api/webhooks/inbound')
      .set('content-type', 'application/json')
      .set('x-graph-delivery-id', 'delivery-2')
      .set('x-graph-timestamp', timestamp)
      .set('x-graph-signature-256', signed)
      .send(validBody);
    expect(wrongId.status).toBe(401);
    expect((await post(validBody, 'delivery-1', String(Number(now()) - 305))).status).toBe(401);
    expect((await post(validBody, 'delivery-1', String(Number(now()) + 65))).status).toBe(401);
    expect((await post(validBody, '../invalid-id')).status).toBe(401);
    expect((await post(validBody, 'delivery-1', 'not-a-timestamp')).status).toBe(401);
    expect((await request(app).post('/api/webhooks/inbound')
      .set('content-type', 'application/json')
      .set('x-graph-delivery-id', 'delivery-1')
      .set('x-graph-timestamp', timestamp)
      .set('x-graph-signature-256', 'sha256=not-hex')
      .send(validBody)).status).toBe(401);
    expect(fixture.enqueueVerifiedWebhook).not.toHaveBeenCalled();
  });

  it('denies non-JSON, malformed JSON and oversized bodies before persistence', async () => {
    const malformed = '{bad json';
    expect((await post(malformed)).status).toBe(400);
    expect((await request(app).post('/api/webhooks/inbound')
      .set('content-type', 'text/plain')
      .set('x-graph-delivery-id', 'delivery-1')
      .set('x-graph-timestamp', now())
      .set('x-graph-signature-256', 'sha256=' + '0'.repeat(64))
      .send(validBody)).status).toBe(415);
    expect((await request(app).post('/api/webhooks/inbound')
      .set('content-type', 'application/json')
      .set('content-encoding', 'gzip')
      .set('x-graph-delivery-id', 'delivery-1')
      .set('x-graph-timestamp', now())
      .set('x-graph-signature-256', 'sha256=' + '0'.repeat(64))
      .send(validBody)).status).toBe(415);
    expect((await post('{"large":"' + 'x'.repeat(256 * 1024) + '"}')).status).toBe(413);
    expect(fixture.enqueueVerifiedWebhook).not.toHaveBeenCalled();
  });

  it('accepts identical atomic-inbox replay, rejects conflicting ID and redacts adapter failure', async () => {
    const firstHash = createHash('sha256').update(validBody).digest('hex');
    fixture.enqueueVerifiedWebhook.mockResolvedValueOnce({ kind: 'inserted', bodySha256: firstHash })
      .mockResolvedValueOnce({ kind: 'duplicate', bodySha256: firstHash })
      .mockResolvedValueOnce({ kind: 'duplicate', bodySha256: firstHash })
      .mockRejectedValueOnce(new Error('PRIVATE_DATABASE_CANARY'));
    expect((await post()).status).toBe(202);
    expect((await post()).status).toBe(202);
    expect((await post('{"kind":"example","value":2}')).status).toBe(409);
    const failed = await post();
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain('PRIVATE_DATABASE_CANARY');
  });
});
