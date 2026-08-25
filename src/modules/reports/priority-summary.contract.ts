import { registerSchema, T, type Static } from '../../contract/typebox';

const SummaryScope = T.Union([T.Literal('VILLAGE'), T.Literal('SECTOR'), T.Literal('REGION'), T.Literal('EXECUTIVE')]);

// Mirrors ScopeFilters (report-summary.service.ts) exactly — all optional,
// since which fields matter depends on `scope`.
const ScopeFiltersSchema = T.Object(
  {
    villageId: T.Optional(T.String({ maxLength: 200 })),
    domainKey: T.Optional(T.String({ maxLength: 200 })),
    regionId: T.Optional(T.String({ maxLength: 200 })),
    villageIds: T.Optional(T.Array(T.String({ maxLength: 200 }), { maxItems: 500 })),
  },
  { additionalProperties: false },
);

export const SummaryScopeBody = registerSchema(
  'SummaryScopeBody',
  T.Object(
    {
      scope: T.Optional(SummaryScope),
      scopeFilters: T.Optional(ScopeFiltersSchema),
    },
    { additionalProperties: false },
  ),
);
export type SummaryScopeDto = Static<typeof SummaryScopeBody>;

// `editedOutputJson`'s real shape is the AI-generated summary output
// (executiveSummary/priorityExplanation strings, etc.) re-saved after an
// officer edits it in place — validated here only as a bounded plain
// object, not a full structural schema, since the frontend editor is the
// actual source of truth for which sub-fields are meaningful and this
// endpoint's job is just to persist whatever it sends back.
const EditedOutputJson = T.Record(T.String({ minLength: 1, maxLength: 200 }), T.Unknown(), { maxProperties: 50 });

export const SaveDraftEditsBody = registerSchema(
  'SaveDraftEditsBody',
  T.Object({ editedOutputJson: EditedOutputJson }, { additionalProperties: false }),
);
export type SaveDraftEditsDto = Static<typeof SaveDraftEditsBody>;

export const SaveSummaryBody = registerSchema(
  'SaveSummaryBody',
  T.Object({ editedOutputJson: T.Optional(EditedOutputJson) }, { additionalProperties: false }),
);
export type SaveSummaryDto = Static<typeof SaveSummaryBody>;

export const ToggleEvidenceInclusionBody = registerSchema(
  'ToggleEvidenceInclusionBody',
  T.Object({ isIncludedInReport: T.Boolean() }, { additionalProperties: false }),
);
export type ToggleEvidenceInclusionDto = Static<typeof ToggleEvidenceInclusionBody>;

// Response schemas (GAP-08 Phase 0, batch 3) — shape sourced from the
// frontend's priority-summary.service.ts (PrioritySummaryRecord/
// PrioritySummaryResponse/PrioritySummaryOutput — this module has no
// separate *.types.ts file). Verified against ReportSummaryService's
// actual return values.
//
// aiOutputJson/officerEditedOutputJson: the AI's structured-output schema
// (priority-dashboard-summary.system.ts et al.) drives what Gemini actually
// returns, and can evolve independently of this response-schema pass — so
// this is registered per the frontend's own read-side PrioritySummaryOutput
// type (the fields the summary editor UI actually reads/writes), not a
// stricter contract enforced anywhere upstream.
export const PrioritySummaryOutputView = registerSchema(
  'PrioritySummaryOutput',
  T.Object({
    executiveSummary: T.String(),
    priorityExplanation: T.String(),
    keyFindings: T.Array(
      T.Object({
        title: T.String(),
        domain: T.String(),
        kpi: T.String(),
        severityScore: T.Union([T.Number(), T.Null()]),
        confidence: T.String(),
        summary: T.String(),
      }),
    ),
    domainInsights: T.Array(
      T.Object({
        domain: T.String(),
        severityScore: T.Union([T.Number(), T.Null()]),
        performanceScore: T.Union([T.Number(), T.Null()]),
        priorityContribution: T.Union([T.Number(), T.Null()]),
        confidence: T.String(),
        summary: T.String(),
      }),
    ),
    criticalOverrideNote: T.Union([T.String(), T.Null()]),
    dataQualityNote: T.String(),
    evidenceSummary: T.Array(
      T.Object({
        evidenceTitle: T.String(),
        sourceReferenceId: T.String(),
        linkedDomainOrKpi: T.String(),
        summary: T.String(),
      }),
    ),
    trendNote: T.String(),
    draftNextSteps: T.Array(T.String()),
  }),
);

const SummaryScopeTypeView = T.Union([
  T.Literal('VILLAGE'),
  T.Literal('SECTOR'),
  T.Literal('REGION'),
  T.Literal('EXECUTIVE'),
]);

// The AiPrioritySummary DB row — returned raw (superset of DB columns) by
// saveDraftEdits/confirmSummary/saveSummary, and as array items by
// getSummaryHistory/getSavedSummariesList. Matches the frontend's
// PrioritySummaryRecord exactly.
export const PrioritySummary = registerSchema(
  'PrioritySummary',
  T.Object({
    id: T.String(),
    orgId: T.String(),
    studyId: T.String(),
    surveyId: T.String(),
    villageId: T.String(),
    reportDataSnapshotId: T.String(),
    status: T.Union([
      T.Literal('DRAFT'),
      T.Literal('SAVED'),
      T.Literal('OFFICER_CONFIRMED'),
      T.Literal('STALE'),
      T.Literal('SUPERSEDED'),
    ]),
    summaryScope: SummaryScopeTypeView,
    scopeFilters: T.Optional(ScopeFiltersSchema),
    promptVersion: T.String(),
    promptHash: T.String(),
    modelName: T.String(),
    modelVersion: T.String(),
    inputReportDataHash: T.String(),
    inputEvidenceSnapshotHash: T.String(),
    aiOutputJson: PrioritySummaryOutputView,
    officerEditedOutputJson: T.Union([PrioritySummaryOutputView, T.Null()]),
    generatedBy: T.String(),
    generatedAt: T.String(),
    officerConfirmedBy: T.Union([T.String(), T.Null()]),
    officerConfirmedAt: T.Union([T.String(), T.Null()]),
    createdAt: T.String(),
    updatedAt: T.String(),
  }),
);

// NOTE (discrepancy, flagged): POST .../preview-snapshot's backend
// (ReportSummaryService.previewSnapshot) actually returns `{ snapshot,
// reportDataHash, evidenceHash }` — but the frontend's previewSnapshot()
// types (and only reads) `{ snapshot: Record<string, unknown> }`, dropping
// the two hash fields entirely. Registered per the frontend's narrower
// shape, per the batch instructions (FE is the source of truth; backend's
// extra fields are simply undocumented here, not incorrect to send).
export const PrioritySummaryPreview = registerSchema(
  'PrioritySummaryPreview',
  T.Object({
    snapshot: T.Record(T.String(), T.Unknown()),
  }),
);

// POST .../generate and GET .../priority-summary's response — matches the
// frontend's PrioritySummaryResponse exactly (`summary` null before a
// summary has ever been generated for this scope).
export const PrioritySummaryResponse = registerSchema(
  'PrioritySummaryResponse',
  T.Object({
    summary: T.Union([PrioritySummary, T.Null()]),
    snapshot: T.Record(T.String(), T.Unknown()),
  }),
);
