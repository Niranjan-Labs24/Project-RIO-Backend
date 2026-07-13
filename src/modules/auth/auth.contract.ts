import { registerSchema, T, type Static } from '../../contract/typebox';

/**
 * No `password` field: the TL's confirmed flow issues a system-generated
 * temporary password instead of a user-chosen one (see
 * AuthService.signup()). No `adminName` either — the signup email itself
 * *is* the NGO Admin account; there's no separate admin identity to name
 * yet in this phase.
 */
export const SignupBody = registerSchema(
  'SignupBody',
  T.Object(
    {
      organizationName: T.String({ minLength: 1, maxLength: 200 }),
      purpose: T.String({ minLength: 1, maxLength: 500 }),
      registrationNumber: T.String({ minLength: 1, maxLength: 100 }),
      email: T.String({ format: 'email' }),
    },
    { additionalProperties: false },
  ),
);
export type SignupDto = Static<typeof SignupBody>;

export const LoginBody = registerSchema(
  'LoginBody',
  T.Object(
    {
      email: T.String({ format: 'email' }),
      password: T.String({ minLength: 1, maxLength: 200 }),
    },
    { additionalProperties: false },
  ),
);
export type LoginDto = Static<typeof LoginBody>;

/** POST /auth/change-password — see AuthService.changePassword(). */
export const ChangePasswordBody = registerSchema(
  'ChangePasswordBody',
  T.Object(
    {
      currentPassword: T.String({ minLength: 1, maxLength: 200 }),
      newPassword: T.String({ minLength: 8, maxLength: 200 }),
    },
    { additionalProperties: false },
  ),
);
export type ChangePasswordDto = Static<typeof ChangePasswordBody>;

/**
 * Shape returned by signup/login/me — matches the frontend's `SessionContext`
 * (see Project-RIO-Frontend's `src/services/auth/auth.types.ts`) so swapping
 * the frontend's mock layer for this API is a response-shape match, not a
 * redesign.
 */
export interface SessionView {
  token: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
  organization: {
    id: string;
    name: string;
    purpose: string;
    registrationNumber: string;
  };
  role: {
    key: string;
  };
  /**
   * True until this user sets their own password via
   * POST /auth/change-password — every signup-issued account starts here
   * with a system-generated temp password, never one they chose. The
   * frontend redirects here-first instead of the dashboard while true (see
   * PasswordChangeGuard).
   */
  mustChangePassword: boolean;
}

/**
 * signup's response — `SessionView` plus how the new admin gets their
 * temporary password. `temporaryPasswordEmailed: true` means MailerService
 * actually sent it (see AuthService.signup()) — nothing further to show.
 * When `false`, the mailer isn't configured yet (or the send failed);
 * `temporaryPassword` is then included as a one-time in-app reveal
 * instead, and only outside production, so a real deployment without a
 * working mailer fails safely (no password anywhere reachable) rather
 * than leaking one.
 */
export interface SignupResponseView extends SessionView {
  temporaryPasswordEmailed: boolean;
  temporaryPassword?: string;
}
