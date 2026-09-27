import { defineConfig } from 'drizzle-kit';

// Generation is offline. This config intentionally contains no database credentials.
// Apply reviewed SQL only through the explicitly guarded dbMigrate runner.
export default defineConfig({
  schema: './src/config/schema.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  verbose: false,
  strict: true,
});
