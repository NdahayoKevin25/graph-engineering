import { describe, expect, it } from 'vitest';
import { databaseOptions } from '../../../../src/config/database-url';

describe('database.neon-postgres.connection', () => {
  it('rejects absent URLs and weakening TLS flags before a connection is created', () => {
    expect(() => databaseOptions(undefined)).toThrow(/configuration/);
    expect(() => databaseOptions('postgresql://fixture:example@remote.invalid/db?sslmode=disable')).toThrow();
    const options=databaseOptions('postgresql://fixture:example@remote.invalid/db?sslmode=require');
    expect(options.ssl).toEqual({rejectUnauthorized:true});
    expect(typeof options.password).toBe('function');
  });
});
