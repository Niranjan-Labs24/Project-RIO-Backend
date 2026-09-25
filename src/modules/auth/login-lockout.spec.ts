import { describe, expect, it } from 'vitest';
import { clearExpiredLock, LOCK_MINUTES, MAX_FAILED_LOGINS, registerFailedLogin } from './login-lockout';

/** In-memory stand-in for the user row: `increment` is applied to the stored
 *  value at the moment the update runs (as the database does), not to a value the
 *  caller read earlier. */
function fakeTx() {
  const row = { failedLoginAttempts: 0, lockedUntil: null as Date | null };
  const tx = {
    user: {
      update: async ({ data, select }: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
        await Promise.resolve();
        const inc = typeof data.failedLoginAttempts === 'object' ? (data.failedLoginAttempts as { increment: number }) : undefined;
        if (inc) row.failedLoginAttempts += inc.increment;
        else if (typeof data.failedLoginAttempts === 'number') row.failedLoginAttempts = data.failedLoginAttempts;
        if ('lockedUntil' in data) row.lockedUntil = data.lockedUntil as Date | null;
        return select ? { failedLoginAttempts: row.failedLoginAttempts } : { ...row };
      },
    },
  };
  return { row, tx: tx as never };
}

describe('registerFailedLogin', () => {
  it('counts every concurrent failure instead of collapsing them into one', async () => {
    const { row, tx } = fakeTx();
    await Promise.all(Array.from({ length: 10 }, () => registerFailedLogin(tx, 'u1')));
    expect(row.failedLoginAttempts).toBe(10);
    expect(row.lockedUntil).not.toBeNull();
  });

  it('does not lock below the limit and leaves lockedUntil null', async () => {
    const { row, tx } = fakeTx();
    for (let i = 0; i < MAX_FAILED_LOGINS - 1; i++) await registerFailedLogin(tx, 'u1');
    expect(row.failedLoginAttempts).toBe(MAX_FAILED_LOGINS - 1);
    expect(row.lockedUntil).toBeNull();
  });

  it('locks for the configured window once the limit is reached', async () => {
    const { row, tx } = fakeTx();
    const now = 1_700_000_000_000;
    let last;
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) last = await registerFailedLogin(tx, 'u1', now);
    expect(last?.attempts).toBe(MAX_FAILED_LOGINS);
    expect(row.lockedUntil?.getTime()).toBe(now + LOCK_MINUTES * 60_000);
  });
});

describe('clearExpiredLock', () => {
  it('lets the first mistake after an expired lock count as the first again instead of re-locking at once', async () => {
    const { row, tx } = fakeTx();
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) await registerFailedLogin(tx, 'u1', 1_000);
    expect(row.lockedUntil).not.toBeNull();

    await clearExpiredLock(tx, 'u1');
    expect(row.failedLoginAttempts).toBe(0);
    expect(row.lockedUntil).toBeNull();

    const next = await registerFailedLogin(tx, 'u1', 2_000_000);
    expect(next.attempts).toBe(1);
    expect(next.lockedUntil).toBeNull();
  });
});
