import { ArgumentsHost, BadRequestException, HttpException } from '@nestjs/common';
import { AllExceptionsFilter } from './http-exception.filter';

function mockHost(): { host: ArgumentsHost; body: () => unknown; status: () => number } {
  let sentBody: unknown;
  let sentStatus = 0;
  const res = {
    status(code: number) {
      sentStatus = code;
      return this;
    },
    json(payload: unknown) {
      sentBody = payload;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ url: '/x' }) }),
  } as unknown as ArgumentsHost;
  return { host, body: () => sentBody, status: () => sentStatus };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('wraps a plain HttpException in the standard envelope', () => {
    const m = mockHost();
    const logger = { error: vi.fn() };
    const spiedFilter = new AllExceptionsFilter(logger);
    spiedFilter.catch(new HttpException('nope', 403), m.host);
    expect(m.status()).toBe(403);
    expect(m.body()).toEqual({ error: { code: 'HTTP_403', message: 'nope' }, message: 'nope', code: 'HTTP_403' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('includes a top-level message the FE client can read', () => {
    const m = mockHost();
    filter.catch(new HttpException('nope', 403), m.host);
    expect(m.body()).toMatchObject({ message: 'nope', error: { code: 'HTTP_403', message: 'nope' } });
  });

  it('passes through an already-enveloped error payload', () => {
    const m = mockHost();
    const enveloped = { error: { code: 'VALIDATION_ERROR', message: 'bad', details: [1] } };
    filter.catch(new BadRequestException(enveloped), m.host);
    expect(m.status()).toBe(400);
    expect(m.body()).toEqual({ ...enveloped, message: 'bad', code: 'VALIDATION_ERROR' });
  });

  it('maps unknown errors to a 500 INTERNAL_ERROR envelope', () => {
    const m = mockHost();
    filter.catch(new Error('boom'), m.host);
    expect(m.status()).toBe(500);
    expect(m.body()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  });

  it('logs server-side (500) exceptions without leaking to the client response', () => {
    const m = mockHost();
    const logger = { error: vi.fn() };
    const spiedFilter = new AllExceptionsFilter(logger);
    spiedFilter.catch(new Error('boom'), m.host);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('does not log client-side (4xx) errors', () => {
    const m = mockHost();
    const logger = { error: vi.fn() };
    const spiedFilter = new AllExceptionsFilter(logger);
    spiedFilter.catch(new HttpException('bad request', 400), m.host);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
