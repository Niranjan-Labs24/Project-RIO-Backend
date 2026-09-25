import { vi } from 'vitest';
import { RateLimitGuard } from './rate-limit.guard';

function context(responseHeaders: Record<string, number>, email = 'user@example.test') {
  const handler = () => undefined;
  return {
    handler,
    value: {
      getHandler: () => handler,
      getClass: () => class TestController {},
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST', path: '/auth/login', route: { path: '/auth/login' }, ip: '127.0.0.1',
          params: {}, body: { email },
        }),
        getResponse: () => ({ setHeader: (name: string, value: number) => { responseHeaders[name] = value; } }),
      }),
    } as never,
  };
}

describe('RateLimitGuard', () => {
  it('blocks requests after the configured local limit', async () => {
    const headers: Record<string, number> = {};
    const ctx = context(headers);
    const reflector = { getAllAndOverride: () => ({ limit: 2, windowSeconds: 60 }) } as never;
    const guard = new RateLimitGuard(reflector, { redisUrl: undefined } as never, { client: undefined } as never);
    await expect(guard.canActivate(ctx.value)).resolves.toBe(true);
    await expect(guard.canActivate(ctx.value)).resolves.toBe(true);
    await expect(guard.canActivate(ctx.value)).rejects.toMatchObject({ status: 429 });
    expect(headers['RateLimit-Remaining']).toBe(0);
    expect(headers['Retry-After']).toBeGreaterThan(0);
  });

  it('keeps identifiers in separate buckets', async () => {
    const reflector = { getAllAndOverride: () => ({ limit: 1, windowSeconds: 60 }) } as never;
    const guard = new RateLimitGuard(reflector, { redisUrl: undefined } as never, { client: undefined } as never);
    await expect(guard.canActivate(context({}).value)).resolves.toBe(true);
    await expect(guard.canActivate(context({}, 'other@example.test').value)).resolves.toBe(true);
  });

  it('drops expired local counters so the fallback map does not grow without bound', async () => {
    vi.useFakeTimers();
    try {
      const reflector = { getAllAndOverride: () => ({ limit: 5, windowSeconds: 30 }) } as never;
      const guard = new RateLimitGuard(reflector, { redisUrl: undefined } as never, { client: undefined } as never);
      for (let i = 0; i < 20; i++) await guard.canActivate(context({}, `user${i}@example.test`).value);
      const local = (guard as unknown as { local: Map<string, unknown> }).local;
      expect(local.size).toBe(20);

      vi.advanceTimersByTime(120_000);
      await guard.canActivate(context({}, 'fresh@example.test').value);

      expect(local.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps one IP across many different identifiers when a per-IP limit is set', async () => {
    const reflector = { getAllAndOverride: () => ({ limit: 5, windowSeconds: 60, perIp: { limit: 3, windowSeconds: 60 } }) } as never;
    const guard = new RateLimitGuard(reflector, { redisUrl: undefined } as never, { client: undefined } as never);
    // Three different emails from the same IP are fine (each has its own bucket)...
    for (let i = 0; i < 3; i++) await expect(guard.canActivate(context({}, `user${i}@example.test`).value)).resolves.toBe(true);
    // ...but the fourth address-hopping attempt hits the IP ceiling.
    await expect(guard.canActivate(context({}, 'user3@example.test').value)).rejects.toMatchObject({ status: 429 });
  });

  it('does not apply the per-IP ceiling when none is configured', async () => {
    const reflector = { getAllAndOverride: () => ({ limit: 5, windowSeconds: 60 }) } as never;
    const guard = new RateLimitGuard(reflector, { redisUrl: undefined } as never, { client: undefined } as never);
    for (let i = 0; i < 10; i++) await expect(guard.canActivate(context({}, `user${i}@example.test`).value)).resolves.toBe(true);
  });
});
