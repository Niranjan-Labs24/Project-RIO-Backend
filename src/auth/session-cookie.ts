import type { CookieOptions } from 'express';

/** httpOnly cookie carrying the session JWT (same token TokenService issues). */
export const SESSION_COOKIE_NAME = 'rio_session';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export function sessionCookieOptions(isProd: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  };
}
