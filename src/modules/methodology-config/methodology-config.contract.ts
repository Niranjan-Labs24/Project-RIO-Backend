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
      // RIO-AI-001. 0..1 (AiDecision.confidence's scale), not 0-100 — see
      // AiClassificationSettings. Ordering (veryLow < low) is enforced in the
      // service, next to validateThresholds, not here: TypeBox can range-check
      // each field but not their relationship.
      // RIO-FR-003 — the raw-to-0-100 conversion rules. Loosely typed on
      // purpose: the strategic axis list is a nested array the methodology
      // owner curates, and the service validates the parts that must hold
      // (ceiling above floor, urgency values within 0-100) where it can
      // check them against each other.
      priorityFactorScales: T.Optional(T.Record(T.String(), T.Unknown())),
      aiClassificationSettings: T.Optional(
        T.Object({
          lowConfidenceThreshold: T.Optional(T.Number({ minimum: 0, maximum: 1 })),
          veryLowConfidenceThreshold: T.Optional(T.Number({ minimum: 0, maximum: 1 })),
        }),
      ),
      // Bounds, not preferences. The floor of 200 stops an administrator
      // setting a threshold so low that every need is summarised (which would
      // spend a model call on two-line statements); the ceiling matches
      // needs.contract.ts's own 5,000-character cap on `statement`, above
      // which the threshold could never be reached at all.
      aiSummarySettings: T.Optional(
        T.Object({
          statementLengthThreshold: T.Optional(T.Integer({ minimum: 200, maximum: 5000 })),
          maxSummaryChars: T.Optional(T.Integer({ minimum: 100, maximum: 2000 })),
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
