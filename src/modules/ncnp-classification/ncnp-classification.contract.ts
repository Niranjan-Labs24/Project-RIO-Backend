import { registerSchema, T, type Static } from '../../contract/typebox';

export const CreateNcnpClassificationBody = registerSchema(
  'CreateNcnpClassificationBody',
  T.Object(
    {
      // 1 = Group (no parent), 2 = Level A (parent is a Group),
      // 3 = Level B (parent is a Level A item).
      level: T.Union([T.Literal(1), T.Literal(2), T.Literal(3)]),
      parentId: T.Optional(T.Union([T.String({ format: 'uuid' }), T.Null()])),
      name: T.String({ minLength: 1, maxLength: 300 }),
      definition: T.Optional(T.Union([T.String({ maxLength: 4000 }), T.Null()])),
      supervisingEntity: T.Optional(T.Union([T.String({ maxLength: 300 }), T.Null()])),
    },
    { additionalProperties: false },
  ),
);
export type CreateNcnpClassificationDto = Static<typeof CreateNcnpClassificationBody>;

export const UpdateNcnpClassificationBody = registerSchema(
  'UpdateNcnpClassificationBody',
  T.Object(
    {
      name: T.Optional(T.String({ minLength: 1, maxLength: 300 })),
      definition: T.Optional(T.Union([T.String({ maxLength: 4000 }), T.Null()])),
      supervisingEntity: T.Optional(T.Union([T.String({ maxLength: 300 }), T.Null()])),
      displayOrder: T.Optional(T.Integer({ minimum: 0 })),
      isActive: T.Optional(T.Boolean()),
    },
    { additionalProperties: false },
  ),
);
export type UpdateNcnpClassificationDto = Static<typeof UpdateNcnpClassificationBody>;
