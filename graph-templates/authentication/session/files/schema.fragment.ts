
// authentication.session: server-side sessions. `id` is HMAC-SHA256(SESSION_SECRET, cookie id);
// the raw session id is never stored. The composite unique index serves per-user revocation.
export const sessionTable = pgTable('sessions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  userId: uuid('user_id').notNull().references(() => userTable.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 32 }).notNull(),
  csrfToken: varchar('csrf_token', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => ({
  userSessionIndex: uniqueIndex('sessions_user_id_id_idx').on(table.userId, table.id),
}));
