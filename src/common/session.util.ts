import jwt from 'jsonwebtoken';
import type { CookieOptions } from 'express';

/** The httpOnly cookie the session JWT is carried in. */
export const SESSION_COOKIE_NAME = 'rio_session';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionTokenPayload {
  sub: string; // user id
  orgId: string;
  role: string;
}

export function signSessionToken(payload: SessionTokenPayload, secret: string): string {
  return jwt.sign(payload, secret, { expiresIn: SESSION_TTL_SECONDS });
}

/** Returns null (never throws) for a missing/expired/tampered token — callers treat it as "not signed in". */
export function verifySessionToken(token: string, secret: string): SessionTokenPayload | null {
  try {
    const decoded = jwt.verify(token, secret);
    if (typeof decoded === 'string') return null;
    const { sub, orgId, role } = decoded as Partial<SessionTokenPayload>;
    if (!sub || !orgId || !role) return null;
    return { sub, orgId, role };
  } catch {
    return null;
  }
}

export function sessionCookieOptions(nodeEnv: string): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: nodeEnv === 'production',
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  };
}
