import { registerSchema, T, type Static } from '../../contract/typebox';

// Same shape as Organisation's own `villages` field (organizations.contract.ts) —
// selected from the org's configured villages, or a new one added inline.
const Villages = T.Array(T.String({ minLength: 1, maxLength: 200 }), { maxItems: 2000 });

export const CreateStudyBody = registerSchema(
  'CreateStudyBody',
  T.Object(
    {
      title: T.String({ minLength: 1, maxLength: 300 }),
      villages: T.Optional(Villages),
    },
    { additionalProperties: false },
  ),
);
export type CreateStudyDto = Static<typeof CreateStudyBody>;

// Title and villages are the only Study-level fields this app lets a user
// edit directly — status only ever advances through the Need/Evidence/AI
// Classification/Human Review workflow, never a direct PATCH.
export const UpdateStudyBody = registerSchema(
  'UpdateStudyBody',
  T.Object(
    {
      title: T.Optional(T.String({ minLength: 1, maxLength: 300 })),
      villages: T.Optional(Villages),
    },
    { additionalProperties: false },
  ),
);
export type UpdateStudyDto = Static<typeof UpdateStudyBody>;
