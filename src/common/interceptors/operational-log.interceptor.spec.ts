import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of, throwError, firstValueFrom, lastValueFrom } from 'rxjs';
import type { ConfigService } from '../../config/config.service';
import type { SystemLogsService } from '../../modules/system-logs/system-logs.service';
import { OperationalLogInterceptor } from './operational-log.interceptor';

function makeContext(
  req: Record<string, unknown> = { method: 'GET', originalUrl: '/api/studies' },
  statusCode = 200,
): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

function makeConfig(over: Partial<{ sampleRate: number; slowMs: number }> = {}) {
  return {
    systemLogSampleRate: over.sampleRate ?? 0,
    systemLogSlowRequestMs: over.slowMs ?? 3000,
  } as unknown as ConfigService;
}

const handler = (value: unknown = 'ok'): CallHandler => ({ handle: () => of(value) });

describe('OperationalLogInterceptor', () => {
  it('records nothing for an ordinary 2xx at the default sample rate of 0', async () => {
    const logs = { record: vi.fn() } as unknown as SystemLogsService;
    const interceptor = new OperationalLogInterceptor(logs, makeConfig());

    await firstValueFrom(interceptor.intercept(makeContext(), handler()));

    expect(logs.record).not.toHaveBeenCalled();
  });

  it('records every 2xx when fully sampled', async () => {
    const logs = { record: vi.fn() } as unknown as SystemLogsService;
    const interceptor = new OperationalLogInterceptor(logs, makeConfig({ sampleRate: 1 }));

    await firstValueFrom(interceptor.intercept(makeContext(), handler()));

    expect(logs.record).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', category: 'http', eventCode: 'HTTP_200' }),
    );
  });

  it('records a slow 2xx as HTTP_SLOW even when sampling is off', async () => {
    const logs = { record: vi.fn() } as unknown as SystemLogsService;
    // Threshold of 0 makes every request "slow" without having to fake time.
    const interceptor = new OperationalLogInterceptor(logs, makeConfig({ slowMs: 0 }));

    await firstValueFrom(interceptor.intercept(makeContext(), handler()));

    expect(logs.record).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', eventCode: 'HTTP_SLOW' }),
    );
  });

  it('leaves errors entirely to AllExceptionsFilter', async () => {
    const logs = { record: vi.fn() } as unknown as SystemLogsService;
    const interceptor = new OperationalLogInterceptor(logs, makeConfig({ sampleRate: 1 }));
    const failing: CallHandler = { handle: () => throwError(() => new Error('boom')) };

    await expect(
      lastValueFrom(interceptor.intercept(makeContext(), failing)),
    ).rejects.toThrow('boom');
    expect(logs.record).not.toHaveBeenCalled();
  });

  it('prefers the parameterised route path so hits on one endpoint group together', async () => {
    const logs = { record: vi.fn() } as unknown as SystemLogsService;
    const interceptor = new OperationalLogInterceptor(logs, makeConfig({ sampleRate: 1 }));
    const req = {
      method: 'GET',
      originalUrl: '/api/studies/0198f2c1-aaaa-bbbb-cccc-ddddeeeeffff',
      route: { path: '/studies/:id' },
    };

    await firstValueFrom(interceptor.intercept(makeContext(req), handler()));

    expect(logs.record).toHaveBeenCalledWith(
      expect.objectContaining({ http: expect.objectContaining({ path: '/studies/:id' }) }),
    );
  });

  it('passes non-http contexts straight through untouched', async () => {
    const logs = { record: vi.fn() } as unknown as SystemLogsService;
    const interceptor = new OperationalLogInterceptor(logs, makeConfig({ sampleRate: 1 }));
    const ctx = { getType: () => 'rpc' } as unknown as ExecutionContext;

    await expect(firstValueFrom(interceptor.intercept(ctx, handler('through')))).resolves.toBe(
      'through',
    );
    expect(logs.record).not.toHaveBeenCalled();
  });

  it('does not break the response when the recorder throws', async () => {
    const logs = {
      record: vi.fn(() => {
        throw new Error('recorder down');
      }),
    } as unknown as SystemLogsService;
    const interceptor = new OperationalLogInterceptor(logs, makeConfig({ sampleRate: 1 }));

    await expect(
      firstValueFrom(interceptor.intercept(makeContext(), handler('payload'))),
    ).resolves.toBe('payload');
  });
});
