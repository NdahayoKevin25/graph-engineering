import { and, asc, count, desc, eq, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import { database } from '../config/database';
import { roleAuditLogTable, roleTable, rolePermissionTable, userRoleTable, userTable } from '../config/schema';
import { AUDIT_PAGE_MAX, MAX_PERMISSIONS_PER_ROLE, MAX_ROLES, type RoleAuditOutcome } from '../utils/roleNames';

/** The pool or a transaction. Every statement is built by Drizzle and sends values as bound parameters. */
export type RoleExecutor = Pick<typeof database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;
export interface RoleRecord { id: string; name: string; builtIn: boolean }
/** One audit row as written: identifiers, a fixed action name and the outcome; never free text. */
export interface RoleAuditEntry {
  actorId: string | null;
  action: string;
  target: string | null;
  /** The role, permission or new role name the change was about; always a validated name. */
  detail: string | null;
  outcome: RoleAuditOutcome;
  status: number | null;
}
export interface RoleAuditRecord {
  id: string;
  occurredAt: Date;
  actorId: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  outcome: string;
  status: number | null;
}
/** Already validated by the service: before is a row id, outcome and action are from the closed lists. */
export interface RoleAuditQuery {
  limit: number;
  before?: string;
  outcome?: RoleAuditOutcome;
  action?: string;
}

const roleColumns = { id: roleTable.id, name: roleTable.name, builtIn: roleTable.builtIn };
const auditColumns = {
  id: roleAuditLogTable.id, occurredAt: roleAuditLogTable.occurredAt, actorId: roleAuditLogTable.actorId,
  action: roleAuditLogTable.action, target: roleAuditLogTable.target, detail: roleAuditLogTable.detail,
  outcome: roleAuditLogTable.outcome, status: roleAuditLogTable.status,
};

export const roleRepository = {
  /** Serializes every role mutation, so last-administrator checks cannot race. */
  async lockRoleAdministration(db: RoleExecutor): Promise<void> {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'graph-roles:administration'}, 0))`);
  },
  async listRoles(db: RoleExecutor): Promise<RoleRecord[]> {
    return db.select(roleColumns).from(roleTable).orderBy(asc(roleTable.name)).limit(MAX_ROLES);
  },
  async countRoles(db: RoleExecutor): Promise<number> {
    const [row] = await db.select({ value: count() }).from(roleTable);
    return Number(row?.value ?? 0);
  },
  async findRoleByName(db: RoleExecutor, name: string): Promise<RoleRecord | null> {
    const [row] = await db.select(roleColumns).from(roleTable).where(eq(roleTable.name, name)).limit(1);
    return row ?? null;
  },
  /** Returns null when the name is already taken. */
  async insertRole(db: RoleExecutor, name: string, builtIn: boolean): Promise<RoleRecord | null> {
    const [row] = await db.insert(roleTable).values({ name, builtIn })
      .onConflictDoNothing({ target: roleTable.name }).returning(roleColumns);
    return row ?? null;
  },
  async renameRole(db: RoleExecutor, id: string, name: string): Promise<RoleRecord | null> {
    const [row] = await db.update(roleTable).set({ name, updatedAt: new Date() })
      .where(and(eq(roleTable.id, id), eq(roleTable.builtIn, false))).returning(roleColumns);
    return row ?? null;
  },
  /** Built-in rows are excluded in SQL as well as in the service. Assignments and grants cascade. */
  async deleteRole(db: RoleExecutor, id: string): Promise<boolean> {
    const rows = await db.delete(roleTable)
      .where(and(eq(roleTable.id, id), eq(roleTable.builtIn, false))).returning({ id: roleTable.id });
    return rows.length === 1;
  },
  async roleNamesForUser(db: RoleExecutor, userId: string): Promise<string[]> {
    const rows = await db.select({ name: roleTable.name }).from(userRoleTable)
      .innerJoin(roleTable, eq(userRoleTable.roleId, roleTable.id))
      .where(eq(userRoleTable.userId, userId)).limit(MAX_ROLES);
    return rows.map((row) => row.name);
  },
  async hasAssignment(db: RoleExecutor, userId: string, roleId: string): Promise<boolean> {
    const rows = await db.select({ id: userRoleTable.id }).from(userRoleTable)
      .where(and(eq(userRoleTable.userId, userId), eq(userRoleTable.roleId, roleId))).limit(1);
    return rows.length === 1;
  },
  /**
   * Holders of a role who can currently sign in: the same rule as resolveAuthenticationIdentity
   * (status 'active' and a verified email). Suspended, unverified and deleted users do not count.
   */
  async countActiveAssignments(db: RoleExecutor, roleId: string, excludingUserId?: string): Promise<number> {
    const [row] = await db.select({ value: count() }).from(userRoleTable)
      .innerJoin(userTable, eq(userTable.id, userRoleTable.userId))
      .where(and(
        eq(userRoleTable.roleId, roleId), eq(userTable.status, 'active'), isNotNull(userTable.emailVerifiedAt),
        excludingUserId === undefined ? undefined : ne(userRoleTable.userId, excludingUserId),
      ));
    return Number(row?.value ?? 0);
  },
  async insertAssignment(db: RoleExecutor, userId: string, roleId: string): Promise<void> {
    await db.insert(userRoleTable).values({ userId, roleId })
      .onConflictDoNothing({ target: [userRoleTable.userId, userRoleTable.roleId] });
  },
  async deleteAssignment(db: RoleExecutor, userId: string, roleId: string): Promise<boolean> {
    const rows = await db.delete(userRoleTable)
      .where(and(eq(userRoleTable.userId, userId), eq(userRoleTable.roleId, roleId))).returning({ id: userRoleTable.id });
    return rows.length === 1;
  },
  async userHasPermission(db: RoleExecutor, userId: string, permission: string): Promise<boolean> {
    const rows = await db.select({ id: rolePermissionTable.id }).from(rolePermissionTable)
      .innerJoin(userRoleTable, eq(userRoleTable.roleId, rolePermissionTable.roleId))
      .where(and(eq(userRoleTable.userId, userId), eq(rolePermissionTable.permission, permission))).limit(1);
    return rows.length === 1;
  },
  async listPermissions(db: RoleExecutor, roleId: string): Promise<string[]> {
    const rows = await db.select({ permission: rolePermissionTable.permission }).from(rolePermissionTable)
      .where(eq(rolePermissionTable.roleId, roleId)).orderBy(asc(rolePermissionTable.permission)).limit(MAX_PERMISSIONS_PER_ROLE);
    return rows.map((row) => row.permission);
  },
  async countPermissions(db: RoleExecutor, roleId: string): Promise<number> {
    const [row] = await db.select({ value: count() }).from(rolePermissionTable).where(eq(rolePermissionTable.roleId, roleId));
    return Number(row?.value ?? 0);
  },
  async insertPermission(db: RoleExecutor, roleId: string, permission: string): Promise<void> {
    await db.insert(rolePermissionTable).values({ roleId, permission })
      .onConflictDoNothing({ target: [rolePermissionTable.roleId, rolePermissionTable.permission] });
  },
  async deletePermission(db: RoleExecutor, roleId: string, permission: string): Promise<boolean> {
    const rows = await db.delete(rolePermissionTable)
      .where(and(eq(rolePermissionTable.roleId, roleId), eq(rolePermissionTable.permission, permission)))
      .returning({ id: rolePermissionTable.id });
    return rows.length === 1;
  },
  /** Append-only: there is deliberately no update or delete for audit rows. */
  async insertAuditEntry(db: RoleExecutor, entry: RoleAuditEntry): Promise<void> {
    await db.insert(roleAuditLogTable).values(entry);
  },
  /**
   * Newest first, bounded to 1..AUDIT_PAGE_MAX rows whatever the caller passes. `before` is the id
   * of the last row of the previous page: the next page holds rows strictly older in
   * (occurred_at, id) order, compared in the database so timestamps keep full precision. An
   * unknown cursor matches no rows.
   */
  async listAuditEntries(db: RoleExecutor, query: RoleAuditQuery): Promise<RoleAuditRecord[]> {
    const bounded = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit, 1), AUDIT_PAGE_MAX) : 1;
    const cursorTime = query.before === undefined ? undefined : db.select({ occurredAt: roleAuditLogTable.occurredAt })
      .from(roleAuditLogTable).where(eq(roleAuditLogTable.id, query.before));
    return db.select(auditColumns).from(roleAuditLogTable)
      .where(and(
        query.outcome === undefined ? undefined : eq(roleAuditLogTable.outcome, query.outcome),
        query.action === undefined ? undefined : eq(roleAuditLogTable.action, query.action),
        cursorTime === undefined || query.before === undefined ? undefined : or(
          lt(roleAuditLogTable.occurredAt, cursorTime),
          and(eq(roleAuditLogTable.occurredAt, cursorTime), lt(roleAuditLogTable.id, query.before)),
        ),
      ))
      .orderBy(desc(roleAuditLogTable.occurredAt), desc(roleAuditLogTable.id)).limit(bounded);
  },
};
