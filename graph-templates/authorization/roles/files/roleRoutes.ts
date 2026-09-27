import express, { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middlewares/authMiddleware';
import { asyncHandler } from '../middlewares/asyncHandler';
import { APIError } from '../middlewares/errorMiddleware';
import { requireAssignedRole } from '../middlewares/roleMiddleware';
import { ADMIN_ROLE, AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX, isPermissionName, isRoleName } from '../utils/roleNames';
import { isIdentityId } from '../utils/tokens';
import {
  assignRole, createRole, deleteRole, grantPermission, listRoleAudit, listRoles,
  recordRoleAuditAttempt, renameRole, revokePermission, revokeRole,
} from '../services/roleService';

const router = express.Router();
/**
 * Runs only once authMiddleware has accepted the caller. Refusals raised before this point
 * (missing or invalid credentials, an untrusted Origin, a CSRF failure) are console-only, so
 * anonymous traffic can never write audit rows.
 */
function markAuthenticated(_req: Request, res: Response, next: NextFunction): void {
  res.locals.roleAuditAuthenticated = true;
  next();
}

// Authentication and the database-backed admin check run before any parameter is parsed or any
// role is looked up, so callers without the admin role learn nothing about which roles exist.
router.use(authMiddleware, markAuthenticated, requireAssignedRole(ADMIN_ROLE));

const nameBody = z.object({ name: z.string().max(32).refine(isRoleName) }).strict();

function roleParam(req: Request): string {
  const value = req.params.role;
  if (!isRoleName(value)) throw new APIError('Invalid role name', 400);
  return value;
}
function userParam(req: Request): string {
  const value = req.params.userId;
  if (!isIdentityId(value)) throw new APIError('Invalid user id', 400);
  return value;
}
function permissionParam(req: Request): string {
  const value = req.params.permission;
  if (!isPermissionName(value)) throw new APIError('Invalid permission', 400);
  return value;
}
function newName(req: Request): string {
  const parsed = nameBody.safeParse(req.body);
  if (!parsed.success) throw new APIError('Invalid role name', 400);
  return parsed.data.name;
}
const AUDIT_QUERY_KEYS: readonly string[] = ['limit', 'before', 'outcome', 'action'];
/** One optional, non-repeated string query value; arrays and nested objects are refused. */
function singleQuery(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new APIError('Invalid audit query', 400);
  return value;
}
/**
 * ?limit (1..AUDIT_PAGE_MAX, default AUDIT_PAGE_DEFAULT), ?before (the id of the last row already
 * seen), ?outcome and ?action. Unknown keys are refused; the service re-validates every value.
 */
function auditQuery(req: Request): { limit: number; before?: string; outcome?: string; action?: string } {
  if (Object.keys(req.query).some((key) => !AUDIT_QUERY_KEYS.includes(key))) throw new APIError('Invalid audit query', 400);
  const raw = singleQuery(req, 'limit');
  if (raw !== undefined && !/^[0-9]{1,3}$/.test(raw)) throw new APIError('Invalid limit', 400);
  const limit = raw === undefined ? AUDIT_PAGE_DEFAULT : Number(raw);
  if (limit < 1 || limit > AUDIT_PAGE_MAX) throw new APIError('Invalid limit', 400);
  const before = singleQuery(req, 'before'), outcome = singleQuery(req, 'outcome'), action = singleQuery(req, 'action');
  return {
    limit,
    ...(before === undefined ? {} : { before }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(action === undefined ? {} : { action }),
  };
}
function actor(req: Request): string {
  const id = req.user?.id;
  if (!isIdentityId(id)) throw new APIError('Authentication required', 401);
  return id;
}
/** Audit record of a successful change. Identifiers only; never tokens, bodies or headers. */
function audit(action: string, actorId: string, detail: Record<string, string>): void {
  console.info('Role administration', { action, actorId, outcome: 'succeeded', ...detail });
}
/** Names the attempted operation from the method and path shape, without echoing raw parameters. */
function attemptedAction(req: Request): string {
  const segments = req.path.split('/').filter(Boolean);
  const kind = segments.length === 3 ? segments[1] : undefined;
  if (segments.length === 0) return req.method === 'GET' ? 'role.list' : req.method === 'POST' ? 'role.create' : 'role.unknown';
  if (segments.length === 1 && segments[0] === 'audit' && req.method === 'GET') return 'audit.read';
  if (segments.length === 1) return req.method === 'PATCH' ? 'role.rename' : req.method === 'DELETE' ? 'role.delete' : 'role.unknown';
  if (kind === 'users') return req.method === 'PUT' ? 'role.assign' : req.method === 'DELETE' ? 'role.revoke' : 'role.unknown';
  if (kind === 'permissions') return req.method === 'PUT' ? 'permission.grant' : req.method === 'DELETE' ? 'permission.revoke' : 'role.unknown';
  return 'role.unknown';
}
/**
 * The attempted target and detail from the path only (never the body), each kept only if it is a
 * well-formed user id, role name or permission name; otherwise null.
 */
function attemptedSubject(req: Request, action: string): { target: string | null; detail: string | null } {
  const segments = req.path.split('/').filter(Boolean);
  if (action === 'audit.read' || segments.length === 0) return { target: null, detail: null };
  const role = isRoleName(segments[0]) ? segments[0] : null;
  if (segments.length === 3 && segments[1] === 'users')
    return { target: isIdentityId(segments[2]) ? segments[2] : null, detail: role };
  if (segments.length === 3 && segments[1] === 'permissions')
    return { target: role, detail: isPermissionName(segments[2]) ? segments[2] : null };
  return { target: role, detail: null };
}

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  res.status(200).json({ data: await listRoles(actor(req)) });
}));
router.get('/audit', asyncHandler(async (req: Request, res: Response) => {
  const actorId = actor(req), query = auditQuery(req);
  res.status(200).json({ data: await listRoleAudit(actorId, query) });
}));
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const actorId = actor(req), name = newName(req);
  const role = await createRole(actorId, name);
  audit('role.create', actorId, { role: name });
  res.status(201).json({ data: role });
}));
router.patch('/:role', asyncHandler(async (req: Request, res: Response) => {
  const actorId = actor(req), role = roleParam(req), name = newName(req);
  const renamed = await renameRole(actorId, role, name);
  audit('role.rename', actorId, { role, newRole: name });
  res.status(200).json({ data: renamed });
}));
router.delete('/:role', asyncHandler(async (req: Request, res: Response) => {
  const actorId = actor(req), role = roleParam(req);
  await deleteRole(actorId, role);
  audit('role.delete', actorId, { role });
  res.status(204).end();
}));
router.put('/:role/users/:userId', asyncHandler(async (req: Request, res: Response) => {
  const actorId = actor(req), role = roleParam(req), userId = userParam(req);
  await assignRole(actorId, userId, role);
  audit('role.assign', actorId, { role, userId });
  res.status(204).end();
}));
router.delete('/:role/users/:userId', asyncHandler(async (req: Request, res: Response) => {
  const actorId = actor(req), role = roleParam(req), userId = userParam(req);
  await revokeRole(actorId, userId, role);
  audit('role.revoke', actorId, { role, userId });
  res.status(204).end();
}));
router.put('/:role/permissions/:permission', asyncHandler(async (req: Request, res: Response) => {
  const actorId = actor(req), role = roleParam(req), permission = permissionParam(req);
  await grantPermission(actorId, role, permission);
  audit('permission.grant', actorId, { role, permission });
  res.status(204).end();
}));
router.delete('/:role/permissions/:permission', asyncHandler(async (req: Request, res: Response) => {
  const actorId = actor(req), role = roleParam(req), permission = permissionParam(req);
  await revokePermission(actorId, role, permission);
  audit('permission.revoke', actorId, { role, permission });
  res.status(204).end();
}));

// Records every refused or failed attempt on the console, including callers stopped before or by
// the admin gate. Attempts by authenticated callers are also stored as role_audit_log rows written
// outside the failed transaction (denials bounded per actor and action; see recordRoleAuditAttempt),
// then the application's error handler responds. The row write never changes the response.
router.use(async (error: unknown, req: Request, res: Response, next: NextFunction) => {
  const status = error instanceof APIError ? error.status : 500;
  const actorId = isIdentityId(req.user?.id) ? req.user!.id : 'anonymous';
  const outcome = status === 401 ? 'unauthenticated' : status === 403 ? 'denied' : 'failed';
  console.warn('Role administration', { action: attemptedAction(req), actorId, outcome, status });
  try {
    if (res.locals.roleAuditAuthenticated === true && status !== 401) {
      const action = attemptedAction(req);
      await recordRoleAuditAttempt({ actorId: req.user?.id, action, ...attemptedSubject(req, action), status });
    }
  } catch {
    console.error('Role audit log write failed', { outcome, status });
  }
  next(error);
});

export const roleRoutes = router;
