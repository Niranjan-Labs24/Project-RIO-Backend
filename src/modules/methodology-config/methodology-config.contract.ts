import { registerSchema, T, type Static } from "../../contract/typebox";

export const UpdateMethodologyConfigBody = registerSchema(
  "UpdateMethodologyConfigBody",
  T.Object(
    {
      version: T.Optional(T.String({ minLength: 1, maxLength: 100 })),
      priorityThresholds: T.Optional(
        T.Object({
          criticalSeverity: T.Optional(T.Integer({ minimum: 0, maximum: 100 })),
          highSeverity: T.Optional(T.Integer({ minimum: 0, maximum: 100 })),
          mediumSeverity: T.Optional(T.Integer({ minimum: 0, maximum: 100 })),
          equityHighSeverity: T.Optional(T.Integer({ minimum: 0, maximum: 100 })),
        }),
      ),
      priorityFactorWeights: T.Optional(
        T.Array(
          T.Object({
            key: T.String({ minLength: 1 }),
            weight: T.Number({ minimum: 0, maximum: 1 }),
          }),
        ),
      ),
      confidenceFlagSettings: T.Optional(
        T.Object({
          dontKnowRatioThreshold: T.Optional(T.Number({ minimum: 0, maximum: 1 })),
          minRespondentsForStandardConfidence: T.Optional(T.Integer({ minimum: 0 })),
        }),
      ),
    },
    { additionalProperties: false },
  ),
);
export type UpdateMethodologyConfigDto = Static<typeof UpdateMethodologyConfigBody>;
