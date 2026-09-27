import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const mock = vi.hoisted(() => ({ hasPermission: vi.fn() }));
vi.mock('../src/services/permissionAuthorizer', () => ({ hasPermission: mock.hasPermission }));

import { PERMISSIONS, requirePermission } from '../src/middlewares/permissionMiddleware';
import { APIError } from '../src/middlewares/errorMiddleware';

const user = { id: '5f5eef88-c157-4f61-92a7-a2fbe33a2129' };
const call = async (req: unknown, next: ReturnType<typeof vi.fn>) =>
  requirePermission(PERMISSIONS[0])(req as Request, {} as Response, next as unknown as NextFunction);

describe('authorization.permissions', () => {
  it('rejects unknown permission declarations before routing', () => {
    expect(() => requirePermission('unlisted:action' as never)).toThrow('Unknown permission');
  });

  it('denies unauthenticated and invalid identities without consulting grants', async () => {
    const next = vi.fn();
    await call({}, next);
    expect(next.mock.calls.at(-1)?.[0]).toBeInstanceOf(APIError);
    expect(next.mock.calls.at(-1)?.[0].status).toBe(401);
    await call({ user: { id: 'forged' } }, next);
    expect(next.mock.calls.at(-1)?.[0].status).toBe(401);
    expect(mock.hasPermission).not.toHaveBeenCalled();
  });

  it('defaults to deny and fails closed on lookup failure', async () => {
    const next = vi.fn();
    mock.hasPermission.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('private database detail'));
    await call({ user }, next);
    expect(next.mock.calls.at(-1)?.[0].status).toBe(403);
    expect(mock.hasPermission).toHaveBeenCalledWith(user.id, PERMISSIONS[0]);
    await call({ user }, next);
    expect(next.mock.calls.at(-1)?.[0].status).toBe(503);
    expect(next.mock.calls.at(-1)?.[0].message).not.toContain('database');
  });

  it('continues only on an explicit true grant', async () => {
    const next = vi.fn();
    mock.hasPermission.mockResolvedValueOnce(true);
    await call({ user }, next);
    expect(next).toHaveBeenCalledWith();
  });
});
