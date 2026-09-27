
export const roleTable = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 32 }).notNull(),
  builtIn: boolean('built_in').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  roleNameIndex: uniqueIndex('roles_name_idx').on(table.name),
}));

export const userRoleTable = pgTable('user_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  roleId: uuid('role_id').notNull().references(() => roleTable.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userRoleIndex: uniqueIndex('user_roles_user_role_idx').on(table.userId, table.roleId),
}));

export const rolePermissionTable = pgTable('role_permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  roleId: uuid('role_id').notNull().references(() => roleTable.id, { onDelete: 'cascade' }),
  permission: varchar('permission', { length: 65 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  rolePermissionIndex: uniqueIndex('role_permissions_role_permission_idx').on(table.roleId, table.permission),
}));

// Append-only audit trail of role administration. Identifiers and outcomes only: no request
// bodies, headers, tokens or free text. The repository exposes insert and select, never update or delete.
export const roleAuditLogTable = pgTable('role_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  actorId: uuid('actor_id'),
  action: varchar('action', { length: 32 }).notNull(),
  target: varchar('target', { length: 64 }),
  detail: varchar('detail', { length: 65 }),
  outcome: varchar('outcome', { length: 16 }).notNull(),
  status: integer('status'),
});
