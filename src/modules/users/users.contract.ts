import { registerSchema, T, type Static } from '../../contract/typebox';

const UserStatusEnum = T.Union([T.Literal('active'), T.Literal('invited'), T.Literal('disabled')]);

// Response schemas (GAP-08 Phase 0) — shape sourced from the frontend's
// OrgUser/UserRoleSummary (Project-RIO-Frontend/src/services/users/users.types.ts)
// so the generated types match what Phase 3 will replace the hand-written
// frontend types with.
const OrgUserRole = registerSchema(
  'OrgUserRole',
  T.Object({
    id: T.String(),
    key: T.String(),
    name: T.String(),
  }),
);

export const OrgUser = registerSchema(
  'OrgUser',
  T.Object({
    id: T.String(),
    name: T.String(),
    email: T.String(),
    role: OrgUserRole,
    status: UserStatusEnum,
    createdAt: T.String(),
  }),
);

// POST /users actually returns this (UsersController#invite ->
// InviteUserResponse), not plain OrgUser — matches the frontend's
// CreateUserResponse exactly.
export const InviteUserResponse = registerSchema(
  'InviteUserResponse',
  T.Object({
    id: T.String(),
    name: T.String(),
    email: T.String(),
    role: OrgUserRole,
    status: UserStatusEnum,
    createdAt: T.String(),
    temporaryPasswordEmailed: T.Boolean(),
    temporaryPassword: T.Optional(T.String()),
  }),
);

// roleId is a stable `role_<key>` string; the service still authorizes WHICH
// role may be assigned (see UsersService.validateRole) — this only bounds shape.
export const InviteUserBody = registerSchema(
  'InviteUserBody',
  T.Object({
    name: T.String({ minLength: 1, maxLength: 200 }),
    email: T.String({ format: 'email', maxLength: 320 }),
    roleId: T.String({ minLength: 1, maxLength: 64 }),
  }),
);
export type InviteUserDto = Static<typeof InviteUserBody>;

export const UpdateUserBody = registerSchema(
  'UpdateUserBody',
  T.Object({
    name: T.Optional(T.String({ minLength: 1, maxLength: 200 })),
    roleId: T.Optional(T.String({ minLength: 1, maxLength: 64 })),
    status: T.Optional(UserStatusEnum),
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
