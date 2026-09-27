import type { PoolConfig } from 'pg';

/** Explicit options prevent URL query flags from weakening TLS or reading host certificate files. */
export function databaseOptions(raw: string | undefined): PoolConfig {
  try {
    if (!raw || raw.length > 4096 || /[\x00-\x20\x7f]/.test(raw)) throw new Error();
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash) throw new Error();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const database = decodeURIComponent(url.pathname.slice(1));
    const user = decodeURIComponent(url.username);
    const credential = decodeURIComponent(url.password);
    const port = url.port ? Number(url.port) : 5432;
    if (!host || !user || !database || /[\/\\\x00-\x1f\x7f]/.test(database + user + credential) ||
        !Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    for (const [key, value] of url.searchParams)
      if (key !== 'sslmode' || !['require', 'verify-full'].includes(value)) throw new Error();
    if (url.searchParams.getAll('sslmode').length > 1) throw new Error();
    const local = ['127.0.0.1', '::1'].includes(host);
    if (!local && !credential) throw new Error();
    const plaintext = local && ['development', 'test'].includes(process.env.NODE_ENV ?? '') &&
      process.env.GRAPH_DATABASE_ALLOW_LOCAL === '1' && !url.searchParams.has('sslmode');
    return {
      // A callback is truthy even for the explicitly empty local-test password:
      // pg must not fall back to PGPASSWORD or a host pgpass file.
      host, port, database, user, password: () => credential,
      ssl: plaintext ? false : { rejectUnauthorized: true },
      enableChannelBinding: true,
      max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000,
      statement_timeout: 30000, query_timeout: 35000,
      options: '-c search_path=public -c lock_timeout=5000',
      application_name: 'graph-generated-app',
    };
  } catch {
    throw new Error('Database configuration is missing or unsupported; credentials are not logged.');
  }
}

/** This acknowledgement records operator intent; it cannot prove a remote database is nonproduction. */
export function operationDatabaseOptions(operation: 'migrate' | 'seed'): PoolConfig {
  const environment = process.env.NODE_ENV;
  if (!['development', 'test', 'production'].includes(environment ?? ''))
    throw new Error('An explicit database operation environment is required.');
  const seed = operation === 'seed';
  const raw = seed ? process.env.SEED_DATABASE_URL : process.env.MIGRATION_DATABASE_URL;
  // DATABASE_URL and NEON_DATABASE_URL are deliberately never fallback targets.
  const options = databaseOptions(raw);
  const expected = process.env.GRAPH_DATABASE_EXPECTED_NAME;
  if (!expected || expected !== options.database)
    throw new Error('Database operation requires an exact expected database name.');
  if (seed) {
    if (!['development', 'test'].includes(environment!) ||
        !['127.0.0.1', '::1'].includes(String(options.host)) ||
        !/_(test|seed|dev)$/.test(expected) ||
        process.env.GRAPH_DATABASE_SEED !== 'isolated-seed-database')
      throw new Error('Seed requires an explicitly acknowledged isolated loopback development/test database.');
  } else if (process.env.GRAPH_DATABASE_MIGRATE !== 'reviewed-migration') {
    throw new Error('Migration requires an explicit reviewed-migration acknowledgement.');
  }
  return { ...options, max: 1, application_name: seed ? 'graph-reviewed-seed' : 'graph-reviewed-migration' };
}
