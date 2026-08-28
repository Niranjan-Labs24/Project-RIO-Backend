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

// RIO-FR-003 AC 5 — a reviewer overriding the computed score. The reason is
// `minLength: 1` because "captured with a reason" is the AC, not a suggestion;
// the service trims and re-checks, and the database has a CHECK constraint
// behind both.
export const OverridePriorityScoreBody = registerSchema(
  'OverridePriorityScoreBody',
  T.Object(
    {
      overrideScore: T.Integer({ minimum: 0, maximum: 100 }),
      reason: T.String({ minLength: 1, maxLength: 2000 }),
    },
    { additionalProperties: false },
  ),
);
export type OverridePriorityScoreDto = Static<typeof OverridePriorityScoreBody>;

// RIO-FR-003 AC 1 — the urgency level a human assigns to a need. The allowed
// keys match the default `priorityFactorScales.urgency` map; a level with no
// entry there scores as unmeasured rather than zero, so config and contract
// drifting apart degrades safely rather than silently scoring 0.
export const SetNeedUrgencyBody = registerSchema(
  'SetNeedUrgencyBody',
  T.Object(
    {
      urgency: T.Union([
        T.Literal('immediate'),
        T.Literal('this_cycle'),
        T.Literal('next_cycle'),
        T.Literal('no_fixed_timeline'),
        T.Null(),
      ]),
    },
    { additionalProperties: false },
  ),
);
export type SetNeedUrgencyDto = Static<typeof SetNeedUrgencyBody>;
