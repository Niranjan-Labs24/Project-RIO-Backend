import { registerSchema, T, type Static } from "../../contract/typebox";

export const CreateSharingRequestBody = registerSchema(
  "CreateSharingRequestBody",
  T.Object(
    {
      ownerOrgId: T.String({ format: "uuid" }),
      studyId: T.String({ format: "uuid" }),
      // "Purpose" in the UI — required so the owning org always has business
      // context to decide against, not just "Request for Study X". Field
      // stays named `note` end-to-end (DB column, audit trail) to avoid an
      // unrelated rename; only the label/requiredness changed.
      note: T.String({ minLength: 1, maxLength: 1000 }),
    },
    { additionalProperties: false },
  ),
);
export type CreateSharingRequestDto = Static<typeof CreateSharingRequestBody>;

// Optional at the schema level (an approve never needs a reason) — reject
// requires a non-empty note, enforced in SharingService.decide() since
// that's a cross-field rule TypeBox can't express here.
export const DecideSharingRequestBody = registerSchema(
  "DecideSharingRequestBody",
  T.Object(
    {
      note: T.Optional(T.String({ maxLength: 1000 })),
    },
    { additionalProperties: false },
  ),
);
export type DecideSharingRequestDto = Static<typeof DecideSharingRequestBody>;

// Response schemas (GAP-08 Phase 0, batch 4) — shape sourced from the
// frontend's SharingRequest/SharedStudySnapshot/OrgLookupResult/
// StudyLookupResult (Project-RIO-Frontend/src/services/sharing/
// sharing.types.ts). Verified field-for-field against sharing.types.ts
// (backend) — identical shapes.
const SharingStatusView = T.Union([
  T.Literal('pending'),
  T.Literal('approved'),
  T.Literal('rejected'),
  T.Literal('expired'),
]);

export const SharingRequestView = registerSchema(
  'SharingRequestView',
  T.Object({
    id: T.String(),
    ownerOrgId: T.String(),
    ownerOrgName: T.String(),
    requestingOrgId: T.String(),
    requestingOrgName: T.String(),
    studyId: T.String(),
    studyTitle: T.String(),
    status: SharingStatusView,
    requestedBy: T.String(),
    requestedAt: T.String(),
    decidedBy: T.Union([T.String(), T.Null()]),
    decidedAt: T.Union([T.String(), T.Null()]),
    note: T.Union([T.String(), T.Null()]),
    decisionNote: T.Union([T.String(), T.Null()]),
  }),
);

// NOTE (discrepancy, flagged): the backend's actual SharedStudySnapshot
// (sharing.types.ts) shape is `{ studyId, title, needs: SharedNeedSnapshot[]
// ({ id, statement, village, status }), evidenceCount }`, but the frontend's
// SharedStudySnapshot (sharing.types.ts) types it as `{ studyId, title,
// status, needStatement: string | null, needVillages: string[],
// evidenceCount }` — a flattened single-need shape, not an array. Registered
// per the frontend shape as instructed (source of truth) — flagged for
// reconciliation; SharingController.getSharedSnapshot's real return value
// should be checked against SharingService.getSharedSnapshot's actual
// mapping before relying on this schema for validation.
export const SharedStudySnapshotView = registerSchema(
  'SharedStudySnapshotView',
  T.Object({
    studyId: T.String(),
    title: T.String(),
    status: T.String(),
    needStatement: T.Union([T.String(), T.Null()]),
    needVillages: T.Array(T.String()),
    evidenceCount: T.Number(),
  }),
);

// Shared with report-sharing.contract.ts's identical lookup rows — kept as
// separately-registered schemas (own name per module, no cross-module
// $ref/import) matching this codebase's existing convention of one flat
// contract file per module with no schema-sharing between them.
export const OrgLookupResultView = registerSchema(
  'OrgLookupResultView',
  T.Object({
    id: T.String(),
    name: T.String(),
  }),
);

export const StudyLookupResultView = registerSchema(
  'StudyLookupResultView',
  T.Object({
    id: T.String(),
    title: T.String(),
  }),
);
