
export const oauthAccountTable = pgTable('oauth_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  provider: varchar('provider', { length: 32 }).notNull(),
  providerSubject: varchar('provider_subject', { length: 255 }).notNull(),
  email: varchar('email', { length: 320 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  providerSubjectIndex: uniqueIndex('oauth_accounts_provider_subject_idx').on(table.provider, table.providerSubject),
  userProviderIndex: uniqueIndex('oauth_accounts_user_provider_idx').on(table.userId, table.provider),
}));
