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

// Reviewer notes are mandatory on both Approve and Reject — same
// requirement and same shape as ApproveSurveyBody/RejectSurveyBody and
// ApproveNcnpReportBody/RejectNcnpReportBody. Whitespace-only strings pass
// minLength:1 (it counts raw characters), so MethodologyConfigService also
// runs the shared requireNonBlank() trim-check.
export const ApproveMethodologyConfigBody = registerSchema(
  "ApproveMethodologyConfigBody",
  T.Object({
    notes: T.String({ minLength: 1, maxLength: 2000 }),
  }),
);
export type ApproveMethodologyConfigDto = Static<typeof ApproveMethodologyConfigBody>;

export const RejectMethodologyConfigBody = registerSchema(
  "RejectMethodologyConfigBody",
  T.Object({
    notes: T.String({ minLength: 1, maxLength: 2000 }),
  }),
);
export type RejectMethodologyConfigDto = Static<typeof RejectMethodologyConfigBody>;
