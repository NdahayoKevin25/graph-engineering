import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTestDatabase, truncateAllTables, closeTestDatabase } from '../../../../tests/setup/testDatabase';
afterEach(async () => { await closeTestDatabase(); vi.unstubAllEnvs(); });
describe('isolated integration database guards', () => {
  it('rejects production and an absent explicit test URL before connecting', () => {
    vi.stubEnv('NODE_ENV', 'production'); expect(() => getTestDatabase()).toThrow(/production/);
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('TEST_DATABASE_URL', undefined);
    expect(() => getTestDatabase()).toThrow(/never a fallback/);
  });
  it('rejects production-like databases and explicit application URL reuse', () => {
    vi.stubEnv('NODE_ENV','test'); vi.stubEnv('TEST_DATABASE_URL','postgresql://localhost/production');
    expect(() => getTestDatabase()).toThrow(/ending in _test/);
    vi.stubEnv('TEST_DATABASE_URL','postgresql://localhost/example_test'); vi.stubEnv('DATABASE_URL','postgresql://localhost/example_test');
    expect(() => getTestDatabase()).toThrow(/differ/);
  });
  it('requires a destructive-operation acknowledgement and validates all identifiers before connecting', async () => {
    vi.stubEnv('NODE_ENV','test'); vi.stubEnv('TEST_DATABASE_URL','postgresql://localhost/example_test'); vi.stubEnv('DATABASE_URL',undefined);
    vi.stubEnv('GRAPH_TEST_DATABASE_ALLOW_TRUNCATE',undefined);
    await expect(truncateAllTables(['users'])).rejects.toThrow(/ALLOW_TRUNCATE/);
    vi.stubEnv('GRAPH_TEST_DATABASE_ALLOW_TRUNCATE','1');
    await expect(truncateAllTables(['users; DROP TABLE users'])).rejects.toThrow(/identifiers/);
    await expect(truncateAllTables(['users','users'])).rejects.toThrow(/identifiers/);
    await expect(truncateAllTables([])).resolves.toBeUndefined();
  });
  it('rejects URL driver overrides and ambiguous application targets before connecting', () => {
    vi.stubEnv('NODE_ENV','test'); vi.stubEnv('DATABASE_URL',undefined);
    for (const query of ['host=production.example','port=9999','sslcert=/private/key','options=-csearch_path=private','sslmode=no-verify','sslmode=disable&sslmode=verify-full']) {
      vi.stubEnv('TEST_DATABASE_URL','postgresql://localhost/example_test?'+query);
      expect(() => getTestDatabase()).toThrow();
    }
    vi.stubEnv('TEST_DATABASE_URL','postgresql://localhost/example_test');
    vi.stubEnv('DATABASE_URL','postgresql://different.example/example_test?host=localhost');
    expect(() => getTestDatabase()).toThrow(/routing overrides/);
    vi.stubEnv('DATABASE_URL','postgresql://different-user@LOCALHOST.:5432/example_test?sslmode=require');
    expect(() => getTestDatabase()).toThrow(/differ/);
  });
});
