import { expect, it } from 'vitest';
import { apiUrl } from '../lib/apiClient';

it('rejects credential-bearing cross-origin paths', () => {
  for (const path of [
    'https://untrusted.invalid/api/data',
    '//untrusted.invalid/api/data',
    '/api/../data',
    '/api/%2e%2e/data',
  ]) expect(() => apiUrl(path)).toThrow();
});
