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
