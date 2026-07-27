import { registerSchema, T, type Static } from '../../contract/typebox';

export const CreateMethodologyVersionBody = registerSchema(
  'CreateMethodologyVersionBody',
  T.Object(
    {
      name: T.String({ minLength: 1, maxLength: 200 }),
      version: T.String({ minLength: 1, maxLength: 50 }),
      description: T.Optional(T.String({ maxLength: 1000 })),
    },
    { additionalProperties: false },
  ),
);
export type CreateMethodologyVersionDto = Static<typeof CreateMethodologyVersionBody>;
