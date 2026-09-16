import type { CookieOptions } from 'express';

/** httpOnly cookie carrying the session JWT (same token TokenService issues). */
export const SESSION_COOKIE_NAME = 'rio_session';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export function sessionCookieOptions(isProd: boolean): CookieOptions {
  return {
    httpOnly: true,
    // Cross-site in production: the frontend is served from a different
    // registrable domain than this API (Vercel -> Render), and a Lax cookie
    // is never sent on a cross-site request — login would set the cookie and
    // every subsequent call would still arrive unauthenticated. 'none'
    // requires Secure, which `secure: isProd` below already supplies. Stays
    // 'lax' in dev, where both run on localhost and Secure is not available.
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  };
}

/** Readable (non-httpOnly) double-submit CSRF token cookie. */
export const CSRF_COOKIE_NAME = 'rio_csrf';

export function csrfCookieOptions(isProd: boolean): CookieOptions {
  return {
    httpOnly: false, // the frontend must read it to echo as X-CSRF-Token
    // Cross-site in production: the frontend is served from a different
    // registrable domain than this API (Vercel -> Render), and a Lax cookie
    // is never sent on a cross-site request — login would set the cookie and
    // every subsequent call would still arrive unauthenticated. 'none'
    // requires Secure, which `secure: isProd` below already supplies. Stays
    // 'lax' in dev, where both run on localhost and Secure is not available.
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
    maxAge: 60 * 60 * 24 * 7 * 1000,
    path: '/',
  };
}
