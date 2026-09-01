import { registerSchema, T, type Static } from '../../contract/typebox';

// A Need can name more than one village — same array-of-strings shape as
// Organisation.villages/region (see organizations.contract.ts). Optional:
// a Need is scoped by its structured Governorate/Centers, village is just
// an additional free-text detail when the submitter happens to know it.
const Villages = T.Array(T.String({ minLength: 1, maxLength: 200 }), { maxItems: 200 });

// Optional multi-select link into the KSA Geographic Reference master data
// — see NeedsService for the actual existence/hierarchy/Study-scope checks
// TypeBox can't express. A single Need can span multiple Governorates/
// Centers (mirrors the Organization's/Study's own multi-select).
const GovernorateIds = T.Array(T.String({ format: 'uuid' }), { maxItems: 150 });
const CenterIds = T.Array(T.String({ format: 'uuid' }), { maxItems: 1404 });

export const CreateNeedBody = registerSchema(
  'CreateNeedBody',
  T.Object(
    {
      // Optional — NeedsService.create() derives a fallback from the
      // statement when omitted/blank, so a Need never ends up with no
      // display title even though the field itself isn't mandatory.
      title: T.Optional(T.String({ maxLength: 300 })),
      statement: T.String({ minLength: 1, maxLength: 5000 }),
      village: T.Optional(Villages),
      governorateIds: T.Optional(GovernorateIds),
      centerIds: T.Optional(CenterIds),
      // The submitter's own external tracking id (a field form number, a
      // partner org's case id, etc.) — free text, never validated.
      referenceId: T.Optional(T.String({ maxLength: 200 })),
    },
    { additionalProperties: false },
  ),
);
export type CreateNeedDto = Static<typeof CreateNeedBody>;

export const UpdateNeedBody = registerSchema(
  'UpdateNeedBody',
  T.Object(
    {
      title: T.Optional(T.String({ minLength: 1, maxLength: 300 })),
      statement: T.Optional(T.String({ minLength: 1, maxLength: 5000 })),
      village: T.Optional(Villages),
      governorateIds: T.Optional(GovernorateIds),
      centerIds: T.Optional(CenterIds),
      referenceId: T.Optional(T.Union([T.String({ maxLength: 200 }), T.Null()])),
    },
    { additionalProperties: false },
  ),
);
export type UpdateNeedDto = Static<typeof UpdateNeedBody>;

export const BulkImportNeedsBody = registerSchema(
  'BulkImportNeedsBody',
  T.Object(
    {
      needs: T.Array(
        T.Object({
          title: T.String({ minLength: 1, maxLength: 300 }),
          statement: T.String({ minLength: 1, maxLength: 5000 }),
          village: T.Optional(T.String({ maxLength: 500 })),
          referenceId: T.Optional(T.String({ maxLength: 200 })),
        }),
        { maxItems: 2000 },
      ),
    },
    { additionalProperties: false },
  ),
);
export type BulkImportNeedsDto = Static<typeof BulkImportNeedsBody>;

// Response schema (GAP-08 Phase 0) — shape sourced from the frontend's Need
// (Project-RIO-Frontend/src/services/needs/needs.types.ts). Verified
// field-for-field identical to the backend's own Need type
// (needs.types.ts) — no discrepancies found.
const NeedStatusEnum = T.Union([
  T.Literal('draft'),
  T.Literal('pending_ai_classification'),
  T.Literal('evidence_submitted'),
  T.Literal('ai_classified'),
  T.Literal('ai_classification_failed'),
  T.Literal('reviewer_approved'),
  T.Literal('survey_created'),
  T.Literal('survey_published'),
]);

const NeedSourceEnum = T.Union([
  T.Literal('manual_entry'),
  T.Literal('file_upload'),
  T.Literal('citizen_input'),
  T.Literal('field_survey'),
]);

const NeedDomainPair = T.Object({
  domain: T.String(),
  subDomain: T.String(),
});

export const Need = registerSchema(
  'Need',
  T.Object({
    id: T.String(),
    studyId: T.String(),
    title: T.String(),
    statement: T.String(),
    village: T.Array(T.String()),
    governorateIds: T.Array(T.String()),
    centerIds: T.Array(T.String()),
    source: NeedSourceEnum,
    referenceId: T.Union([T.String(), T.Null()]),
    internalReferenceId: T.String(),
    status: NeedStatusEnum,
    domain: T.Union([T.String(), T.Null()]),
    subDomain: T.Union([T.String(), T.Null()]),
    allDomainsSelected: T.Boolean(),
    needDomains: T.Array(NeedDomainPair),
    aiSuggestedDomain: T.Union([T.String(), T.Null()]),
    aiSuggestedSubDomain: T.Union([T.String(), T.Null()]),
    classifiedAt: T.Union([T.String(), T.Null()]),
    classificationError: T.Union([T.String(), T.Null()]),
    proposedDomains: T.Union([T.Array(NeedDomainPair), T.Null()]),
    proposedReason: T.Union([T.String(), T.Null()]),
    createdBy: T.String(),
    createdByName: T.Union([T.String(), T.Null()]),
    createdAt: T.String(),
    updatedAt: T.String(),
  }),
);

// Response schema (GAP-08 Phase 0) — shape sourced from the frontend's
// Evidence (Project-RIO-Frontend/src/services/evidence/evidence.types.ts).
// Verified field-for-field identical to the backend's own Evidence type
// (src/modules/evidence/evidence.types.ts) — no discrepancies found.
export const Evidence = registerSchema(
  'Evidence',
  T.Object({
    id: T.String(),
    needId: T.String(),
    studyId: T.String(),
    fileName: T.String(),
    fileType: T.String(),
    fileSize: T.Number(),
    uploadedBy: T.String(),
    uploadedByName: T.Union([T.String(), T.Null()]),
    uploadedAt: T.String(),
    isDuplicate: T.Optional(T.Boolean()),
  }),
);
