import { NextFunction, Request, Response } from 'express';
import { APIError } from './errorMiddleware';
import { isIdentityId } from '../utils/tokens';
import { isPermissionName, isRoleName } from '../utils/roleNames';
import { hasPermission, rolesForUser } from '../services/roleService';

type Guard = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/**
 * Mount after authMiddleware. Allows the request only if the authenticated user currently holds
 * one of the named roles in the database. The token's role claim, req.user.role, headers and
 * bodies are ignored. Denials never say which role was required or which roles exist.
 */
export function requireAssignedRole(...roles: string[]): Guard {
  if (roles.length < 1 || roles.length > 16 || !roles.every(isRoleName))
    throw new Error('requireAssignedRole needs 1-16 valid role names');
  const required = Object.freeze([...new Set(roles)]);
  return async (req, _res, next) => {
    const userId = req.user?.id;
    if (!isIdentityId(userId)) { next(new APIError('Authentication required', 401)); return; }
    let allowed = false;
    try {
      const held = await rolesForUser(userId);
      allowed = required.some((role) => held.has(role) === true);
    } catch {
      next(new APIError('Authorization unavailable', 503));
      return;
    }
    if (!allowed) {
      next(new APIError('Forbidden', 403));
      return;
    }
    next();
  };
}

/** Mount after authMiddleware. Allows the request only on an explicit database grant through a held role. */
export function requireAssignedPermission(permission: string): Guard {
  if (!isPermissionName(permission)) throw new Error('requireAssignedPermission needs a resource:action name');
  return async (req, _res, next) => {
    const userId = req.user?.id;
    if (!isIdentityId(userId)) { next(new APIError('Authentication required', 401)); return; }
    let granted: unknown;
    try {
      granted = await hasPermission(userId, permission);
    } catch {
      next(new APIError('Authorization unavailable', 503));
      return;
    }
    if (granted !== true) { next(new APIError('Forbidden', 403)); return; }
    next();
  };
}
