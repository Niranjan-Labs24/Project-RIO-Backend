import { registerSchema, T, type Static } from '../../contract/typebox';

// A Need can name more than one village — same array-of-strings shape as
// Organisation.villages/region (see organizations.contract.ts).
const Villages = T.Array(T.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 200 });

export const CreateNeedBody = registerSchema(
  'CreateNeedBody',
  T.Object(
    {
      statement: T.String({ minLength: 1, maxLength: 5000 }),
      village: Villages,
      source: T.String({ minLength: 1, maxLength: 200 }),
    },
    { additionalProperties: false },
  ),
);
export type CreateNeedDto = Static<typeof CreateNeedBody>;

export const UpdateNeedBody = registerSchema(
  'UpdateNeedBody',
  T.Object(
    {
      statement: T.Optional(T.String({ minLength: 1, maxLength: 5000 })),
      village: T.Optional(Villages),
      source: T.Optional(T.String({ minLength: 1, maxLength: 200 })),
    },
    { additionalProperties: false },
  ),
);
export type UpdateNeedDto = Static<typeof UpdateNeedBody>;
