import type { Prisma } from '../../generated/prisma';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

/**
 * Records one failed sign-in for a user and locks the account once the limit is
 * reached.
 *
 * The counter is incremented in the database (`increment`), not computed from a
 * value read earlier: with read-then-write, N concurrent guesses all read the
 * same count and register as a single failure, defeating the lockout. The
 * increment takes a row lock, so concurrent failures serialize inside the
 * caller's transaction.
 */
export async function registerFailedLogin(
  tx: Pick<Prisma.TransactionClient, 'user'>,
  userId: string,
  now: number = Date.now(),
): Promise<{ attempts: number; lockedUntil: Date | null }> {
  const { failedLoginAttempts } = await tx.user.update({
    where: { id: userId },
    data: { failedLoginAttempts: { increment: 1 } },
    select: { failedLoginAttempts: true },
  });
  const lockedUntil = failedLoginAttempts >= MAX_FAILED_LOGINS ? new Date(now + LOCK_MINUTES * 60_000) : null;
  await tx.user.update({ where: { id: userId }, data: { lockedUntil } });
  return { attempts: failedLoginAttempts, lockedUntil };
}

/** Resets the failure count once a lock has run out, so the next mistake counts as the first again. */
export async function clearExpiredLock(tx: Pick<Prisma.TransactionClient, 'user'>, userId: string): Promise<void> {
  await tx.user.update({ where: { id: userId }, data: { failedLoginAttempts: 0, lockedUntil: null } });
}
