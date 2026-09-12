import { registerSchema, T, type Static } from '../../contract/typebox';

const UserStatusEnum = T.Union([T.Literal('active'), T.Literal('invited'), T.Literal('disabled')]);

// roleId is a stable `role_<key>` string; the service still authorizes WHICH
// role may be assigned (see UsersService.validateRole) — this only bounds shape.
export const InviteUserBody = registerSchema(
  'InviteUserBody',
  T.Object({
    name: T.String({ minLength: 1, maxLength: 200 }),
    email: T.String({ format: 'email', maxLength: 320 }),
    roleId: T.String({ minLength: 1, maxLength: 64 }),
    // RIO MFA — optional at invite time, for any role: capturing it here is
    // what makes "Sign in with OTP" available to that user later, regardless
    // of role. See UsersService.invite / AuthService.requestLoginOtp.
    mobileNumber: T.Optional(T.String({ maxLength: 32 })),
  }),
);
export type InviteUserDto = Static<typeof InviteUserBody>;

export const UpdateUserBody = registerSchema(
  'UpdateUserBody',
  T.Object({
    name: T.Optional(T.String({ minLength: 1, maxLength: 200 })),
    roleId: T.Optional(T.String({ minLength: 1, maxLength: 64 })),
    status: T.Optional(UserStatusEnum),
    // RIO MFA — lets an admin add/change/clear (empty string) an existing
    // user's mobile number after invite, e.g. once they've supplied it.
    mobileNumber: T.Optional(T.String({ maxLength: 32 })),
  }),
);
export type UpdateUserDto = Static<typeof UpdateUserBody>;

export const AssignNgoAdminBody = registerSchema(
  'AssignNgoAdminBody',
  T.Object({
    userId: T.Optional(T.String({ format: 'uuid' })),
    name: T.Optional(T.String({ minLength: 1, maxLength: 200 })),
    email: T.Optional(T.String({ format: 'email', maxLength: 320 })),
    reason: T.Optional(T.String({ maxLength: 500 })),
  }),
);
export type AssignNgoAdminDto = Static<typeof AssignNgoAdminBody>;

export const UpdateUserRoleBody = registerSchema(
  'UpdateUserRoleBody',
  T.Object({
    roleId: T.String({ minLength: 1, maxLength: 64 }),
    reason: T.Optional(T.String({ maxLength: 500 })),
  }),
);
export type UpdateUserRoleDto = Static<typeof UpdateUserRoleBody>;

export const UpdateUserStatusBody = registerSchema(
  'UpdateUserStatusBody',
  T.Object({
    status: UserStatusEnum,
    reason: T.Optional(T.String({ maxLength: 500 })),
  }),
);
export type UpdateUserStatusDto = Static<typeof UpdateUserStatusBody>;
