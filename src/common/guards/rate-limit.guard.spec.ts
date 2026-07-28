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
    const guard = new RateLimitGuard(reflector, { redisUrl: undefined } as never);
    await expect(guard.canActivate(ctx.value)).resolves.toBe(true);
    await expect(guard.canActivate(ctx.value)).resolves.toBe(true);
    await expect(guard.canActivate(ctx.value)).rejects.toMatchObject({ status: 429 });
    expect(headers['RateLimit-Remaining']).toBe(0);
    expect(headers['Retry-After']).toBeGreaterThan(0);
  });

  it('keeps identifiers in separate buckets', async () => {
    const reflector = { getAllAndOverride: () => ({ limit: 1, windowSeconds: 60 }) } as never;
    const guard = new RateLimitGuard(reflector, { redisUrl: undefined } as never);
    await expect(guard.canActivate(context({}).value)).resolves.toBe(true);
    await expect(guard.canActivate(context({}, 'other@example.test').value)).resolves.toBe(true);
  });
});
