import { registerSchema, T, type Static } from '../../contract/typebox';

const UserStatusEnum = T.Union([T.Literal('active'), T.Literal('invited')]);

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
