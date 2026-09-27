import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

let cached: { url: string; pool: Pool; database: ReturnType<typeof drizzle> } | undefined;
function parseTarget(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid PostgreSQL connection URL (value redacted).'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash ||
      url.hostname.includes('%') || [...url.searchParams.keys()].some(key => key !== 'sslmode') ||
      url.searchParams.getAll('sslmode').length > 1)
    throw new Error('PostgreSQL URL routing overrides, certificate paths and ambiguous targets are forbidden.');
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  url.port ||= '5432';
  return url;
}
function testUrl(): string {
  if (process.env.NODE_ENV !== 'test') throw new Error('A test database requires NODE_ENV=test; production connections are forbidden.');
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('Set an explicit TEST_DATABASE_URL; DATABASE_URL is never a fallback.');
  const url = parseTarget(value);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z][a-z0-9_]{0,57}_test$/.test(databaseName))
    throw new Error('TEST_DATABASE_URL must name a dedicated PostgreSQL database ending in _test.');
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode && !['disable', 'verify-full'].includes(sslmode))
    throw new Error('Test URL sslmode must be disable for isolated local databases or verify-full for TLS.');
  if (process.env.DATABASE_URL) {
    const application = parseTarget(process.env.DATABASE_URL);
    if (application.hostname === url.hostname && application.port === url.port &&
        decodeURIComponent(application.pathname.slice(1)) === databaseName)
      throw new Error('TEST_DATABASE_URL must differ from the application DATABASE_URL target, not only its credentials.');
  }
  return url.href;
}
export function getTestDatabase() {
  const url = testUrl();
  if (cached && cached.url !== url) throw new Error('Close the existing test database before changing its URL.');
  if (!cached) {
    const pool = new Pool({ connectionString: url, user: decodeURIComponent(new URL(url).username) || 'postgres', max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, application_name: 'graph-engineering-tests' });
    cached = { url, pool, database: drizzle(pool) };
  }
  return cached.database;
}
export async function closeTestDatabase(): Promise<void> {
  const previous = cached; cached = undefined;
  await previous?.pool.end();
}
/** Only explicitly listed public-schema tables; never CASCADE into unlisted data. */
export async function truncateAllTables(tableNames: string[]): Promise<void> {
  testUrl();
  if (process.env.GRAPH_TEST_DATABASE_ALLOW_TRUNCATE !== '1')
    throw new Error('Destructive test cleanup requires GRAPH_TEST_DATABASE_ALLOW_TRUNCATE=1.');
  if (!Array.isArray(tableNames) || tableNames.length > 1000 || new Set(tableNames).size !== tableNames.length ||
      tableNames.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(name)))
    throw new Error('Test cleanup requires a bounded list of distinct table identifiers.');
  if (!tableNames.length) return;
  const tables = tableNames.map(name => sql.join([sql.identifier('public'), sql.identifier(name)], sql.raw('.')));
  await getTestDatabase().execute(sql.join([sql.raw('TRUNCATE TABLE '), sql.join(tables, sql.raw(', ')), sql.raw(' RESTART IDENTITY')]));
}
