import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { operationDatabaseOptions } from '../config/database-url';

export async function migrateDatabase(): Promise<void> {
  const pool = new Pool(operationDatabaseOptions('migrate'));
  pool.on('error', () => { console.error('Migration connection failed.'); });
  try {
    const client = await pool.connect();
    let locked = false;
    try {
      const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(174824711, 1) AS locked');
      locked = result.rows[0]?.locked === true;
      if (!locked) throw new Error('A database operation is already active.');
      const migrations = readMigrationFiles({ migrationsFolder: './src/migrations' });
      if (migrations.length > 1000 || migrations.some((entry, index) =>
          !Number.isSafeInteger(entry.folderMillis) ||
          (index > 0 && entry.folderMillis <= migrations[index - 1]!.folderMillis)))
        throw new Error('Migration journal requires a bounded chronological sequence.');
      const existing = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS journal");
      if (existing.rows[0]?.journal) {
        const applied = await client.query<{ hash: string; created_at: string }>('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id');
        if (applied.rows.some((row, index) => row.hash !== migrations[index]?.hash ||
            Number(row.created_at) !== migrations[index]?.folderMillis))
          throw new Error('Applied migrations differ from the reviewed local history.');
      }
      await migrate(drizzle(client), { migrationsFolder: './src/migrations' });
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(174824711, 1)').catch(() => {});
      client.release();
    }
  } catch { throw new Error('Reviewed migration failed; credentials and SQL are not exposed.'); }
  finally { await pool.end(); }
}

if (require.main === module) {
  migrateDatabase().then(() => { console.log('Reviewed migrations applied.'); }).catch(() => {
    console.error('Migration failed; inspect approved database diagnostics. Credentials and SQL are not logged.');
    process.exitCode = 1;
  });
}
