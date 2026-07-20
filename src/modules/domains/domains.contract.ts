import { registerSchema, T, type Static } from '../../contract/typebox';

// `code` is the stable identifier AI classification/Question Bank imports
// key off of (matches question-bank-v1.json's hierarchy[].code /
// subDomains[].code) — never auto-derived from `name`, so renaming a
// Domain's display name can never silently break that linkage.
export const CreateDomainBody = registerSchema(
  'CreateDomainBody',
  T.Object(
    {
      code: T.String({ minLength: 1, maxLength: 64 }),
      name: T.String({ minLength: 1, maxLength: 200 }),
      displayOrder: T.Optional(T.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
);
export type CreateDomainDto = Static<typeof CreateDomainBody>;

export const UpdateDomainBody = registerSchema(
  'UpdateDomainBody',
  T.Object(
    {
      code: T.Optional(T.String({ minLength: 1, maxLength: 64 })),
      name: T.Optional(T.String({ minLength: 1, maxLength: 200 })),
      displayOrder: T.Optional(T.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
);
export type UpdateDomainDto = Static<typeof UpdateDomainBody>;

export const CreateSubDomainBody = registerSchema(
  'CreateSubDomainBody',
  T.Object(
    {
      code: T.String({ minLength: 1, maxLength: 64 }),
      name: T.String({ minLength: 1, maxLength: 200 }),
      displayOrder: T.Optional(T.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
);
export type CreateSubDomainDto = Static<typeof CreateSubDomainBody>;

export const UpdateSubDomainBody = registerSchema(
  'UpdateSubDomainBody',
  T.Object(
    {
      code: T.Optional(T.String({ minLength: 1, maxLength: 64 })),
      name: T.Optional(T.String({ minLength: 1, maxLength: 200 })),
      displayOrder: T.Optional(T.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
);
export type UpdateSubDomainDto = Static<typeof UpdateSubDomainBody>;
