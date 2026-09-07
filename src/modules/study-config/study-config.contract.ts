import { registerSchema, T, type Static } from '../../contract/typebox';

export const CreateStudyConfigOptionBody = registerSchema(
  'CreateStudyConfigOptionBody',
  T.Object(
    {
      name: T.String({ minLength: 1, maxLength: 100 }),
      // RIO Arabic Localization (Approach 3, Hybrid) — optional so an admin
      // can add the English value first and fill in Arabic afterward.
      nameAr: T.Optional(T.String({ minLength: 1, maxLength: 100 })),
      displayOrder: T.Optional(T.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
);
export type CreateStudyConfigOptionDto = Static<typeof CreateStudyConfigOptionBody>;

export const UpdateStudyConfigOptionBody = registerSchema(
  'UpdateStudyConfigOptionBody',
  T.Object(
    {
      name: T.Optional(T.String({ minLength: 1, maxLength: 100 })),
      nameAr: T.Optional(T.String({ minLength: 1, maxLength: 100 })),
      displayOrder: T.Optional(T.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
);
export type UpdateStudyConfigOptionDto = Static<typeof UpdateStudyConfigOptionBody>;
