import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';

describe('database.migrations', () => {
  // This is a generated-artifact check, NOT migration/rollback runtime evidence.
  // The engine's isolated PostgreSQL fixture executes the actual lifecycle.
  it('migration workflow documentation exists in a generated project', () => {
    const path = resolve(__dirname, '../../../../src/migrations/README.md');
    expect(existsSync(path)).toBe(true);
  });
});
