import { registerSchema, T, type Static } from '../../contract/typebox';
import { PERMISSION_MODULES } from '../../rbac/role-matrix';

const ModuleLiteral = T.Union(PERMISSION_MODULES.map((m) => T.Literal(m)));
const ActionLiteral = T.Union([
  T.Literal('read'),
  T.Literal('write'),
  T.Literal('create'),
  T.Literal('approve'),
  T.Literal('export'),
  T.Literal('share'),
]);

export const CreatePermissionGrantBody = registerSchema(
  'CreatePermissionGrantBody',
  T.Object(
    {
      granteeId: T.String({ format: 'uuid' }),
      module: ModuleLiteral,
      action: ActionLiteral,
      // Omitted = every entity the grantee can already cross-entity read.
      targetOrgId: T.Optional(T.String({ format: 'uuid' })),
      reason: T.String({ minLength: 1, maxLength: 1000 }),
      expiresAt: T.Optional(T.String({ format: 'date-time' })),
    },
    { additionalProperties: false },
  ),
);
export type CreatePermissionGrantDto = Static<typeof CreatePermissionGrantBody>;
