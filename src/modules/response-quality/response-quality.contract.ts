import { registerSchema, T } from '../../contract/typebox';

// This module's controller (response-quality.controller.ts) has no
// request-body routes at all — assess/generateSummary take only path/query
// params, no @Body(). Only response schemas (GAP-08 Phase 0, batch 4) are
// registered here.
//
// Shape sourced from the frontend's ResponseQualityResult/AiSummary
// (Project-RIO-Frontend/src/services/response-quality/
// response-quality.types.ts). Verified field-for-field against
// response-quality.types.ts (backend) — identical shapes.
export const ResponseQualityResultView = registerSchema(
  'ResponseQualityResultView',
  T.Object({
    id: T.String(),
    needId: T.String(),
    studyId: T.String(),
    // Null = computed across every Survey Link ("Consolidated"); set =
    // scoped to just that one link.
    surveyLinkId: T.Union([T.String(), T.Null()]),
    surveyResponseId: T.String(),
    completenessScore: T.Number(),
    missingFields: T.Array(T.String()),
    confidenceFlag: T.Union([T.Literal('standard'), T.Literal('low')]),
    isDuplicate: T.Boolean(),
    duplicateOfId: T.Union([T.String(), T.Null()]),
    assessedAt: T.String(),
  }),
);

export const AiSummaryView = registerSchema(
  'AiSummaryView',
  T.Object({
    id: T.String(),
    needId: T.String(),
    studyId: T.String(),
    surveyLinkId: T.Union([T.String(), T.Null()]),
    summaryText: T.String(),
    responseCount: T.Number(),
    generatedAt: T.String(),
  }),
);
