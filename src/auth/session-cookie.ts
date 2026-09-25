import type { CookieOptions } from 'express';

/** httpOnly cookie carrying the session JWT (same token TokenService issues). */
export const SESSION_COOKIE_NAME = 'rio_session';

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

/** JWT_EXPIRES_IN ("12h", "30m", "7d" or plain seconds) as seconds; unparseable values fall back to 12 hours. */
export function tokenLifetimeSeconds(expiresIn: string): number {
  const match = /^\s*(\d+)\s*([smhd])?\s*$/.exec(expiresIn);
  if (!match) return 12 * 3600;
  return Number(match[1]) * UNIT_SECONDS[match[2] ?? 's']!;
}

// The cookie lives exactly as long as the token inside it, so the browser drops it when it stops working.
export function sessionCookieOptions(isProd: boolean, expiresIn = '12h'): CookieOptions {
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
    maxAge: tokenLifetimeSeconds(expiresIn) * 1000,
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
