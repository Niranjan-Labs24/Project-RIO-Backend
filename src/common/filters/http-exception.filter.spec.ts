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

  // ──────── RIO-NFR-016 — persisted operational log ────────

  it('records a 500 as an error with its stack, alongside the stdout line', () => {
    const m = mockHost();
    const logger = { error: vi.fn() };
    const systemLogs = { record: vi.fn() };
    new AllExceptionsFilter(logger, systemLogs).catch(new Error('boom'), m.host);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(systemLogs.record).toHaveBeenCalledTimes(1);
    expect(systemLogs.record).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        category: 'http',
        eventCode: 'INTERNAL_ERROR',
        message: 'boom',
        error: expect.any(Error),
        http: expect.objectContaining({ statusCode: 500 }),
      }),
    );
  });

  it('records a 4xx as a warning, without a stack', () => {
    const m = mockHost();
    const systemLogs = { record: vi.fn() };
    new AllExceptionsFilter(undefined, systemLogs).catch(new HttpException('nope', 404), m.host);

    const arg = systemLogs.record.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.level).toBe('warn');
    // A 404's stack says "a guard threw" and nothing more — storing
    // thousands of those buys noise, not diagnostics.
    expect(arg.error).toBeUndefined();
  });

  it('files 401/403 under the auth category, not generic http', () => {
    const systemLogs = { record: vi.fn() };
    const filterWithLogs = new AllExceptionsFilter(undefined, systemLogs);

    filterWithLogs.catch(new HttpException('unauthorized', 401), mockHost().host);
    filterWithLogs.catch(new HttpException('forbidden', 403), mockHost().host);
    filterWithLogs.catch(new HttpException('missing', 404), mockHost().host);

    const categories = systemLogs.record.mock.calls.map((c) => (c[0] as { category: string }).category);
    expect(categories).toEqual(['auth', 'auth', 'http']);
  });

  it('prefers the envelope error code as the grouping key', () => {
    const systemLogs = { record: vi.fn() };
    const enveloped = { error: { code: 'NO_ORG_CONTEXT', message: 'no org' } };
    new AllExceptionsFilter(undefined, systemLogs).catch(
      new HttpException(enveloped, 403),
      mockHost().host,
    );

    expect((systemLogs.record.mock.calls[0]?.[0] as { eventCode: string }).eventCode).toBe('NO_ORG_CONTEXT');
  });

  it('records nothing for a 2xx-range HttpException', () => {
    const systemLogs = { record: vi.fn() };
    new AllExceptionsFilter(undefined, systemLogs).catch(
      new HttpException('redirected', 302),
      mockHost().host,
    );
    expect(systemLogs.record).not.toHaveBeenCalled();
  });

  it('still answers the client when the recorder itself throws', () => {
    const m = mockHost();
    const systemLogs = {
      record: vi.fn(() => {
        throw new Error('recorder down');
      }),
    };
    new AllExceptionsFilter(undefined, systemLogs).catch(new Error('boom'), m.host);

    expect(m.status()).toBe(500);
    expect(m.body()).toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
