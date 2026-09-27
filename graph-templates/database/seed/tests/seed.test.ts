import { afterEach, describe, expect, it, vi } from 'vitest';
import { operationDatabaseOptions } from '../../../../src/config/database-url';

afterEach(() => vi.unstubAllEnvs());

describe('database.seed', () => {
  it('refuses production and never falls back to the application URL', () => {
    vi.stubEnv('NODE_ENV','production');
    vi.stubEnv('DATABASE_URL','postgresql://fixture@127.0.0.1/fixture_test');
    vi.stubEnv('SEED_DATABASE_URL','');
    expect(() => operationDatabaseOptions('seed')).toThrow();
  });
});
