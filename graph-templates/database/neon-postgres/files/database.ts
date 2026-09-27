import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { SECRETS } from '../utils/helpers';
import { databaseOptions } from './database-url';

// Standard PostgreSQL/TLS transport for a persistent Node process, including Neon.
// Constructing a pool does not establish a connection or apply migrations.
export const pool = new Pool(databaseOptions(SECRETS.DATABASE_URL));
pool.on('error', () => { console.error('Database pool connection failed.'); });
export const database = drizzle(pool);
