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

// Response schemas (GAP-08 Phase 0, batch 3) — shape sourced from the
// frontend's priority.types.ts (PriorityScore/PriorityDashboardEntry) and
// severity-scoring.service.ts (MethodologyVersion/SeverityDashboardResult/
// SeverityKpiRankingEntry/QuestionDetailResult/VillagePriorityResult).
// Verified field-for-field against PriorityService/PriorityV2Service —
// PriorityScore's declared backend type (priority.types.ts) matches the
// frontend exactly, even though PriorityService.score()'s actual `factors`
// value at runtime is a summary object rather than the declared
// PriorityFactor[] array — a pre-existing type/runtime mismatch in the
// backend itself, not something this response-schema pass resolves.
const PriorityFactor = T.Object({
  indicator: T.String(),
  weight: T.Number(),
  responseValue: T.Number(),
  weightedContribution: T.Number(),
});

const PriorityLevel = T.Union([
  T.Literal('critical'),
  T.Literal('high'),
  T.Literal('medium'),
  T.Literal('low'),
]);

export const PriorityScore = registerSchema(
  'PriorityScore',
  T.Object({
    id: T.String(),
    needId: T.String(),
    studyId: T.String(),
    surveyLinkId: T.Union([T.String(), T.Null()]),
    overallScore: T.Number(),
    level: PriorityLevel,
    gapType: T.String(),
    factors: T.Array(PriorityFactor),
    cycleNote: T.Union([T.String(), T.Null()]),
    scoredAt: T.String(),
    isApproved: T.Boolean(),
    approvedAt: T.Union([T.String(), T.Null()]),
  }),
);

// Org-wide dashboard row — every Need, whether or not it's been scored yet.
export const PriorityDashboardEntry = registerSchema(
  'PriorityDashboardEntry',
  T.Object({
    studyId: T.String(),
    studyTitle: T.String(),
    needId: T.String(),
    score: T.Union([
      T.Object({
        overallScore: T.Number(),
        level: PriorityLevel,
        gapType: T.Union([T.String(), T.Null()]),
        scoredAt: T.String(),
      }),
      T.Null(),
    ]),
  }),
);

// GET/POST /methodology-versions — PriorityService.listMethodologyVersions/
// createMethodologyVersion both return the raw MethodologyVersion Prisma
// row; matches the frontend's MethodologyVersion (severity-scoring.service.ts)
// field-for-field.
export const MethodologyVersion = registerSchema(
  'MethodologyVersion',
  T.Object({
    id: T.String(),
    name: T.String(),
    version: T.String(),
    description: T.Union([T.String(), T.Null()]),
    status: T.String(),
    createdAt: T.String(),
  }),
);

// POST /methodology-versions/{id}/upload-lookups.
// NOTE (discrepancy, fixed here): ROUTES previously documented this
// route's response as `MethodologyVersion`. PriorityService.uploadLookups
// actually returns `{ imported: number }` (a count of the CSV rows
// imported) — it never re-reads or returns the MethodologyVersion row.
// Matches the frontend's uploadLookups() return type
// (severity-scoring.service.ts) exactly. Wired to the real/frontend shape
// per the batch instructions rather than the stale documented one.
export const UploadLookupsResult = registerSchema(
  'UploadLookupsResult',
  T.Object({
    imported: T.Number(),
  }),
);

// GET /studies/{studyId}/surveys/{surveyId}/severity-dashboard —
// PriorityController.getSeverityDashboard / PriorityService.getDashboard.
// Matches the frontend's SeverityDashboardResult (severity-scoring.service.ts).
const SeverityOverallView = T.Object({
  severityScore: T.Union([T.Number(), T.Null()]),
  confidenceLevel: T.String(),
  validResponseCount: T.Number(),
  dontKnowRate: T.Number(),
});

const SeverityDomainRowView = T.Object({
  id: T.String(),
  name: T.String(),
  severityScore: T.Union([T.Number(), T.Null()]),
  confidenceLevel: T.String(),
  validResponseCount: T.Number(),
});

const SeveritySubLevelRowView = T.Object({
  id: T.String(),
  name: T.String(),
  severityScore: T.Union([T.Number(), T.Null()]),
  confidenceLevel: T.String(),
});

export const SeverityDashboardResult = registerSchema(
  'SeverityDashboardResult',
  T.Object({
    overall: T.Union([SeverityOverallView, T.Null()]),
    domains: T.Array(SeverityDomainRowView),
    subDomains: T.Array(SeveritySubLevelRowView),
    indicators: T.Array(SeveritySubLevelRowView),
    kpis: T.Array(SeveritySubLevelRowView),
    methodologyVersion: T.String(),
  }),
);

// GET /studies/{studyId}/surveys/{surveyId}/severity-kpis —
// PriorityService.getKpiRanking. Matches the frontend's
// SeverityKpiRankingEntry (severity-scoring.service.ts).
export const SeverityKpiRankingEntry = registerSchema(
  'SeverityKpiRankingEntry',
  T.Object({
    rank: T.Number(),
    kpi: T.String(),
    indicator: T.String(),
    subDomain: T.String(),
    domain: T.String(),
    severityScore: T.Union([T.Number(), T.Null()]),
    validResponseCount: T.Number(),
    dontKnowRate: T.Number(),
    confidenceLevel: T.String(),
  }),
);

// GET /studies/{studyId}/surveys/{surveyId}/questions/{questionId} —
// PriorityService.getQuestionDetail. Matches the frontend's
// QuestionDetailResult (severity-scoring.service.ts).
export const QuestionDetailResult = registerSchema(
  'QuestionDetailResult',
  T.Object({
    questionId: T.String(),
    questionText: T.String(),
    isScoreable: T.Boolean(),
    domain: T.String(),
    subDomain: T.String(),
    kpi: T.String(),
    indicator: T.String(),
    averageSeverity: T.Union([T.Number(), T.Null()]),
    validCount: T.Number(),
    excludedCount: T.Number(),
    dontKnowCount: T.Number(),
    notApplicableCount: T.Number(),
    methodologyVersion: T.String(),
    optionsDistribution: T.Array(
      T.Object({
        optionId: T.String(),
        label: T.String(),
        count: T.Number(),
      }),
    ),
    lookups: T.Array(
      T.Object({
        optionId: T.Union([T.String(), T.Null()]),
        lookupType: T.String(),
        severityScore: T.Union([T.Number(), T.Null()]),
        isExcluded: T.Boolean(),
        exclusionReason: T.Union([T.String(), T.Null()]),
      }),
    ),
    calculatedAt: T.String(),
  }),
);

// GET /studies/{studyId}/surveys/{surveyId}/village-priority —
// PriorityV2Service.getVillagePriority. Matches the frontend's
// VillagePriorityResult (severity-scoring.service.ts).
export const VillagePriorityResult = registerSchema(
  'VillagePriorityResult',
  T.Object({
    priorityScore: T.Number(),
    priorityStatus: T.Union([T.Literal('HIGH'), T.Literal('MEDIUM'), T.Literal('LOW')]),
    overrideApplied: T.Boolean(),
    overrideReason: T.Union([T.String(), T.Null()]),
    domainComponents: T.Array(
      T.Object({
        domainKey: T.String(),
        domainNameSnapshot: T.String(),
        domainSeverityScore: T.Number(),
        domainPerformanceScore: T.Number(),
        domainWeight: T.Number(),
        weightedContribution: T.Number(),
        isCriticalDomain: T.Boolean(),
        criticalThreshold: T.Number(),
        triggeredOverride: T.Boolean(),
      }),
    ),
    calculatedAt: T.String(),
    calculationVersion: T.String(),
    methodologyVersion: T.String(),
  }),
);
