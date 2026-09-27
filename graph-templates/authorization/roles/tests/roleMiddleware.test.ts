import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const mock = vi.hoisted(() => ({ rolesForUser: vi.fn(), hasPermission: vi.fn() }));
vi.mock('../src/services/roleService', () => ({ rolesForUser: mock.rolesForUser, hasPermission: mock.hasPermission }));
// Mirrors isIdentityId in src/utils/tokens.ts, which also loads secrets at import time.
vi.mock('../src/utils/tokens', () => ({
  isIdentityId: (value: unknown) => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
}));

import { requireAssignedPermission, requireAssignedRole } from '../src/middlewares/roleMiddleware';
import { isPermissionName, isRoleName } from '../src/utils/roleNames';

const user = { id: '5f5eef88-c157-4f61-92a7-a2fbe33a2129' };
const run = async (guard: ReturnType<typeof requireAssignedRole>, req: unknown) => {
  const next = vi.fn();
  await guard(req as Request, {} as Response, next as unknown as NextFunction);
  return next;
};

describe('authorization.roles middleware', () => {
  beforeEach(() => { mock.rolesForUser.mockReset(); mock.hasPermission.mockReset(); });

  it('validates role and permission names against strict patterns and lengths', () => {
    for (const name of ['admin', 'support-agent', 'b2', 'a'.repeat(32)]) expect(isRoleName(name)).toBe(true);
    for (const name of ['', 'a', 'Admin', '1admin', 'a'.repeat(33), 'admin\n', "x'; drop table roles; --", '__proto__ ', 'ädmin', 5])
      expect(isRoleName(name)).toBe(false);
    expect(isPermissionName('orders:refund')).toBe(true);
    for (const name of ['orders:*', 'orders', 'Orders:refund', 'a:b:c']) expect(isPermissionName(name)).toBe(false);
    for (const roles of [[], ['Admin'], ['a'.repeat(33)], Array.from({ length: 17 }, (_, i) => `role${i}`)])
      expect(() => requireAssignedRole(...roles)).toThrow();
    expect(() => requireAssignedPermission('orders:*')).toThrow();
  });

  it('denies missing or malformed identities without a database lookup', async () => {
    const malformed = ['forged', `${user.id}\n`, '5f5eef88-c157-6f61-92a7-a2fbe33a2129', '5f5eef88-c157-4f61-72a7-a2fbe33a2129', 42];
    for (const req of [{}, { user: {} }, ...malformed.map((id) => ({ user: { id, role: 'admin' } }))]) {
      const next = await run(requireAssignedRole('admin'), req);
      expect(next.mock.calls[0][0].status).toBe(401);
    }
    expect(mock.rolesForUser).not.toHaveBeenCalled();
  });

  it('looks up well-formed identities in any letter case and still denies without an assignment', async () => {
    mock.rolesForUser.mockResolvedValue(new Set());
    const upper = user.id.toUpperCase();
    const next = await run(requireAssignedRole('admin'), { user: { id: upper, role: 'admin' } });
    expect(next.mock.calls[0][0].status).toBe(403);
    expect(mock.rolesForUser).toHaveBeenCalledWith(upper);
  });

  it('denies by default: no roles, unknown roles and a client or token role claim all get 403', async () => {
    mock.rolesForUser.mockResolvedValue(new Set());
    const req = { user: { ...user, role: 'admin' }, headers: { 'x-role': 'admin' }, body: { role: 'admin' } };
    for (const guard of [requireAssignedRole('admin'), requireAssignedRole('never-created')]) {
      const next = await run(guard, req);
      expect(next.mock.calls[0][0].status).toBe(403);
      expect(next.mock.calls[0][0].message).toBe('Forbidden');
    }
    mock.rolesForUser.mockResolvedValue(new Set(['editor']));
    expect((await run(requireAssignedRole('admin'), { user })).mock.calls[0][0].status).toBe(403);
    expect(mock.rolesForUser).toHaveBeenCalledWith(user.id);
  });

  it('fails closed without leaking lookup details', async () => {
    mock.rolesForUser.mockRejectedValue(new Error('private database detail'));
    const next = await run(requireAssignedRole('admin'), { user });
    expect(next.mock.calls[0][0].status).toBe(503);
    expect(next.mock.calls[0][0].message).not.toContain('database');
  });

  it('allows only roles the database currently assigns', async () => {
    mock.rolesForUser.mockResolvedValue(new Set(['editor']));
    const next = await run(requireAssignedRole('admin', 'editor'), { user });
    expect(next).toHaveBeenCalledWith();
  });

  it('requires an explicit true permission grant', async () => {
    for (const [answer, status] of [[false, 403], ['true', 403], [undefined, 403]] as const) {
      mock.hasPermission.mockResolvedValueOnce(answer);
      const next = await run(requireAssignedPermission('orders:refund'), { user });
      expect(next.mock.calls[0][0].status).toBe(status);
    }
    mock.hasPermission.mockResolvedValueOnce(true);
    expect(await run(requireAssignedPermission('orders:refund'), { user })).toHaveBeenCalledWith();
    expect(mock.hasPermission).toHaveBeenCalledWith(user.id, 'orders:refund');
  });
});
