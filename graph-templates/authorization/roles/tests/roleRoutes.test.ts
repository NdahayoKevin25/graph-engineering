import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';

const service = vi.hoisted(() => ({
  held: new Map<string, Set<string>>(),
  rolesForUser: vi.fn(),
  hasPermission: vi.fn(async () => false),
  listRoles: vi.fn(async () => [{ name: 'admin', builtIn: true, permissions: [] }]),
  createRole: vi.fn(async (_actor: string, name: string) => ({ name, builtIn: false, permissions: [] })),
  renameRole: vi.fn(),
  deleteRole: vi.fn(async () => undefined),
  assignRole: vi.fn(async () => undefined),
  revokeRole: vi.fn(async () => undefined),
  grantPermission: vi.fn(async () => undefined),
  revokePermission: vi.fn(async () => undefined),
  listRoleAudit: vi.fn(async () => [] as unknown[]),
  recordRoleAuditAttempt: vi.fn(async (_attempt: Record<string, unknown>) => true),
}));
vi.mock('../src/services/roleService', () => service);
// Mirrors isIdentityId in src/utils/tokens.ts, which also loads secrets at import time.
vi.mock('../src/utils/tokens', () => ({
  isIdentityId: (value: unknown) => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
}));
// Test double for the JWT middleware: the authenticated id comes from a test-only header. The
// untrusted role claim is set to 'admin' for everyone to prove it is never used for the decision.
vi.mock('../src/middlewares/authMiddleware', async () => {
  const { APIError } = await import('../src/middlewares/errorMiddleware');
  return {
    authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
      const id = req.headers['x-test-user'];
      // Stands in for an Origin or CSRF check that refuses before the caller is authenticated.
      if (req.headers['x-test-refuse-origin'] === '1') { next(new APIError('Origin not permitted', 403)); return; }
      if (typeof id !== 'string') { next(new APIError('Authentication required', 401)); return; }
      req.user = { id, email: '', role: 'admin' } as NonNullable<Request['user']>;
      next();
    },
  };
});

import { roleRoutes } from '../src/routes/roleRoutes';
import { errorHandler } from '../src/middlewares/errorMiddleware';

const admin = '11111111-1111-4111-8111-111111111111';
const member = '33333333-3333-4333-8333-333333333333';
const app = express();
app.use(express.json());
app.use('/api/roles', roleRoutes);
app.use(errorHandler);
const management = ['listRoles', 'createRole', 'renameRole', 'deleteRole', 'assignRole', 'revokeRole', 'grantPermission', 'revokePermission', 'listRoleAudit'] as const;

describe('authorization.roles admin routes', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const name of management) service[name].mockClear();
    service.recordRoleAuditAttempt.mockReset();
    service.recordRoleAuditAttempt.mockImplementation(async () => true);
    service.held = new Map([[admin, new Set(['admin'])], [member, new Set(['editor'])]]);
    service.rolesForUser.mockImplementation(async (id: string) => service.held.get(id) ?? new Set());
  });

  it('requires authentication', async () => {
    const response = await request(app).get('/api/roles');
    expect(response.status).toBe(401);
  });

  it('gives non-admins one identical 403 whatever role they name, before any lookup or validation', async () => {
    const bodies = new Set<string>();
    for (const [method, url] of [
      ['get', '/api/roles'], ['delete', '/api/roles/admin'], ['delete', '/api/roles/does-not-exist'],
      ['patch', '/api/roles/NOT%20VALID'], ['put', `/api/roles/admin/users/${member}`], ['post', '/api/roles'],
      ['get', '/api/roles/audit'],
    ] as const) {
      const response = await request(app)[method](url).set('x-test-user', member).set('x-role', 'admin').send({ name: 'owner', role: 'admin' });
      expect(response.status).toBe(403);
      bodies.add(JSON.stringify(response.body));
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: { message: 'Forbidden', status: 403 } })]);
    for (const name of management) expect(service[name]).not.toHaveBeenCalled();
  });

  it('validates names, ids and bodies strictly for administrators', async () => {
    for (const body of [{}, { name: 'Owner' }, { name: 'a'.repeat(33) }, { name: 'owner', builtIn: true }, { name: ['owner'] }]) {
      const response = await request(app).post('/api/roles').set('x-test-user', admin).send(body);
      expect(response.status).toBe(400);
    }
    expect((await request(app).put('/api/roles/editor/users/not-a-uuid').set('x-test-user', admin)).status).toBe(400);
    expect((await request(app).put('/api/roles/editor/permissions/orders:*').set('x-test-user', admin)).status).toBe(400);
    expect(service.createRole).not.toHaveBeenCalled();
    expect(service.assignRole).not.toHaveBeenCalled();
  });

  it('audits refused and failed attempts with actor, action and outcome only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await request(app).delete('/api/roles/admin').set('x-test-user', member).send({ secret: 'do-not-log' });
    expect(warn).toHaveBeenLastCalledWith('Role administration', { action: 'role.delete', actorId: member, outcome: 'denied', status: 403 });
    await request(app).get('/api/roles');
    expect(warn).toHaveBeenLastCalledWith('Role administration', { action: 'role.list', actorId: 'anonymous', outcome: 'unauthenticated', status: 401 });
    const { APIError } = await import('../src/middlewares/errorMiddleware');
    service.revokeRole.mockRejectedValueOnce(new APIError('The last active administrator cannot be removed', 409));
    const response = await request(app).delete(`/api/roles/admin/users/${admin}`).set('x-test-user', admin);
    expect(response.status).toBe(409);
    expect(warn).toHaveBeenLastCalledWith('Role administration', { action: 'role.revoke', actorId: admin, outcome: 'failed', status: 409 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('do-not-log');
  });

  it('stores refused and failed attempts by authenticated callers only, without changing the response', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await request(app).delete('/api/roles/admin').set('x-test-user', member).send({ secret: 'do-not-log' });
    expect(service.recordRoleAuditAttempt).toHaveBeenLastCalledWith({ actorId: member, action: 'role.delete', target: 'admin', detail: null, status: 403 });
    await request(app).put(`/api/roles/editor/users/${member}`).set('x-test-user', member);
    expect(service.recordRoleAuditAttempt).toHaveBeenLastCalledWith({ actorId: member, action: 'role.assign', target: member, detail: 'editor', status: 403 });
    await request(app).put('/api/roles/editor/permissions/orders:refund').set('x-test-user', member);
    expect(service.recordRoleAuditAttempt).toHaveBeenLastCalledWith({ actorId: member, action: 'permission.grant', target: 'editor', detail: 'orders:refund', status: 403 });
    expect(JSON.stringify(service.recordRoleAuditAttempt.mock.calls)).not.toContain('do-not-log');
    // Anonymous and origin-refused requests are console-only: no row is ever attempted.
    service.recordRoleAuditAttempt.mockClear();
    for (let index = 0; index < 20; index += 1) {
      expect((await request(app).get('/api/roles/audit')).status).toBe(401);
      expect((await request(app).delete('/api/roles/admin').set('x-test-user', member).set('x-test-refuse-origin', '1')).status).toBe(403);
    }
    expect(service.recordRoleAuditAttempt).not.toHaveBeenCalled();
    // Even if storing the row fails outright, the denial is still a generic 403.
    service.recordRoleAuditAttempt.mockRejectedValueOnce(new Error('private audit storage detail'));
    const response = await request(app).delete('/api/roles/admin').set('x-test-user', member);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: 'Forbidden', status: 403 } });
  });

  it('serves a bounded, filtered, cursor-paged audit page to administrators only', async () => {
    const page = [{ id: 'row', action: 'role.create', target: 'support', outcome: 'succeeded' }];
    service.listRoleAudit.mockResolvedValueOnce(page);
    const response = await request(app).get('/api/roles/audit').set('x-test-user', admin);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: page });
    expect(service.listRoleAudit).toHaveBeenLastCalledWith(admin, { limit: 50 });
    const cursor = '44444444-4444-4444-8444-444444444444';
    await request(app).get(`/api/roles/audit?limit=200&before=${cursor}&outcome=denied&action=role.delete`).set('x-test-user', admin).expect(200);
    expect(service.listRoleAudit).toHaveBeenLastCalledWith(admin, { limit: 200, before: cursor, outcome: 'denied', action: 'role.delete' });
    for (const query of ['limit=0', 'limit=201', 'limit=-1', 'limit=1.5', 'limit=1e2', 'limit=abc', 'limit=', 'limit=1&limit=2',
      `before=${cursor}&before=${cursor}`, 'outcome[x]=denied', 'actor=someone', 'offset=10'])
      expect((await request(app).get(`/api/roles/audit?${query}`).set('x-test-user', admin)).status).toBe(400);
    expect(service.listRoleAudit).toHaveBeenCalledTimes(2);
  });

  it('passes the authenticated administrator as actor and records an audit event', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await request(app).post('/api/roles').set('x-test-user', admin).send({ name: 'support' });
    expect(response.status).toBe(201);
    expect(service.createRole).toHaveBeenCalledWith(admin, 'support');
    expect(info).toHaveBeenCalledWith('Role administration', { action: 'role.create', actorId: admin, outcome: 'succeeded', role: 'support' });
    expect((await request(app).delete(`/api/roles/admin/users/${member}`).set('x-test-user', admin)).status).toBe(204);
    expect(service.revokeRole).toHaveBeenCalledWith(admin, member, 'admin');
  });
});
