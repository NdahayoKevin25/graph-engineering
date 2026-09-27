import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorHandler, APIError } from '../../../../src/middlewares/errorMiddleware';

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}
afterEach(() => vi.restoreAllMocks());

describe('backend.error-handler', () => {
  it('formats an APIError using its status', () => {
    const res = mockRes();
    errorHandler(new APIError('Not found', 404), {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: { message: 'Not found', status: 404 } });
  });

  it('defaults a plain Error to 500', () => {
    const res = mockRes();
    errorHandler(new Error('boom'), {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: { message: 'Something went wrong', status: 500 } });
  });

  it('redacts internal API errors from both output and logs', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const error of [new Error('PRIVATE_TOKEN_CANARY'), new APIError('PRIVATE_TOKEN_CANARY', 500), new APIError('PRIVATE_TOKEN_CANARY', 503)]) {
      const res = mockRes();
      errorHandler(error, {} as any, res, vi.fn());
      expect(JSON.stringify(res.json.mock.calls)).not.toContain('PRIVATE_TOKEN_CANARY');
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_TOKEN_CANARY');
    expect(log).toHaveBeenLastCalledWith('Request failed', { status: 503 });
  });

  it('preserves a parser client-error status without returning its private message', () => {
    const res = mockRes();
    errorHandler(Object.assign(new SyntaxError('PRIVATE_BODY_CANARY'), { status: 400 }), {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: { message: 'Request failed', status: 400 } });
  });

  it.each([0, 200, 600, Number.NaN, 401.5])('normalizes invalid error status %j without echoing its message', (status) => {
    const res = mockRes();
    errorHandler(new APIError('INTERNAL_CANARY', status), {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: { message: 'Something went wrong', status: 500 } });
  });
});
