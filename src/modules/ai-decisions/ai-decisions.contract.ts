import { registerSchema, T, type Static } from '../../contract/typebox';

export const ReviewDecisionBody = registerSchema(
  'ReviewDecisionBody',
  T.Object(
    {
      decision: T.Union([T.Literal('approved'), T.Literal('rejected'), T.Literal('modified')]),
      notes: T.Optional(T.String({ maxLength: 2000 })),
      overrideValue: T.Optional(T.Unknown()),
    },
    { additionalProperties: false },
  ),
);
export type ReviewDecisionDto = Static<typeof ReviewDecisionBody>;
