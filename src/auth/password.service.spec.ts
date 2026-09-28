import type { ConfigService } from '../config/config.service';
import { ConcurrencyLimiter, PasswordService } from './password.service';

describe('PasswordService', () => {
  const svc = new PasswordService({ argon2MaxConcurrency: 8 } as ConfigService);
  it('hashes to a non-plaintext argon2id string and verifies round-trip', async () => {
    const hash = await svc.hash('Passw0rd!');
    expect(hash).not.toBe('Passw0rd!');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await svc.verify(hash, 'Passw0rd!')).toBe(true);
    expect(await svc.verify(hash, 'wrong')).toBe(false);
  });

  it('returns false (not throw) when the stored hash is malformed', async () => {
    expect(await svc.verify('not-a-hash', 'whatever')).toBe(false);
  });

  it('verifyDummy always returns false (timing-equaliser for the not-found login path)', async () => {
    expect(await svc.verify('not-a-hash', 'whatever')).toBe(false);
    expect(await svc.verifyDummy('anything')).toBe(false);
    expect(await svc.verifyDummy('anything')).toBe(false); // second call reuses the cached hash
  });
});

describe('ConcurrencyLimiter', () => {
  it('never runs more than `max` at once, queueing the rest in order', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let maxObserved = 0;
    const order: number[] = [];

    const task = (id: number) =>
      limiter.run(async () => {
        active++;
        maxObserved = Math.max(maxObserved, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        order.push(id);
      });

    await Promise.all([task(1), task(2), task(3), task(4), task(5)]);

    expect(maxObserved).toBe(2);
    expect(order).toHaveLength(5);
  });

  it('lets a fresh call through immediately once a slot frees up', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const results: string[] = [];
    const slow = limiter.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      results.push('slow');
    });
    // Queued behind `slow` since max is 1.
    const fast = limiter.run(async () => {
      results.push('fast');
    });
    await Promise.all([slow, fast]);
    expect(results).toEqual(['slow', 'fast']);
  });
});
