import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}

/**
 * Issued at signup instead of a user-chosen password — there's no email
 * delivery yet, so the caller (AuthService.signup()) is responsible for
 * getting this to the new admin (dev-only response field / log) until a
 * real "email a temporary password" flow replaces that. 16 base64url
 * characters (~96 bits of entropy) — plenty for a credential meant to be
 * used once and changed, no ambiguous characters to transcribe since it's
 * shown/copied, never typed by hand.
 */
export function generateTemporaryPassword(): string {
  return randomBytes(12).toString('base64url');
}
