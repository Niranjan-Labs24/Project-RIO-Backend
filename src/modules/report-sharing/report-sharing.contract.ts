import { registerSchema, T, type Static } from "../../contract/typebox";

export const CreateReportSharingRequestBody = registerSchema(
  "CreateReportSharingRequestBody",
  T.Object(
    {
      ownerOrgId: T.String({ format: "uuid" }),
      reportId: T.String({ format: "uuid" }),
      // "Purpose" in the UI — required so the owning org always has business
      // context to decide against, not just "Request for Report X". Field
      // stays named `note` end-to-end (DB column, audit trail) to avoid an
      // unrelated rename; only the label/requiredness changed.
      note: T.String({ minLength: 1, maxLength: 1000 }),
    },
    { additionalProperties: false },
  ),
);
export type CreateReportSharingRequestDto = Static<typeof CreateReportSharingRequestBody>;

// Optional at the schema level (an approve never needs a reason) — reject
// requires a non-empty note, enforced in ReportSharingService.decide()
// since that's a cross-field rule TypeBox can't express here.
export const DecideReportSharingRequestBody = registerSchema(
  "DecideReportSharingRequestBody",
  T.Object(
    {
      note: T.Optional(T.String({ maxLength: 1000 })),
    },
    { additionalProperties: false },
  ),
);
export type DecideReportSharingRequestDto = Static<typeof DecideReportSharingRequestBody>;

// Response schemas (GAP-08 Phase 0, batch 4) — shape sourced from the
// frontend's ReportSharingRequest/SharedReportSnapshot/OrgLookupResult/
// ReportLookupResult (Project-RIO-Frontend/src/services/report-sharing/
// report-sharing.types.ts). Verified field-for-field against
// report-sharing.types.ts (backend) — identical shapes.
const SharingStatusView = T.Union([
  T.Literal('pending'),
  T.Literal('approved'),
  T.Literal('rejected'),
  T.Literal('expired'),
]);

export const ReportSharingRequestView = registerSchema(
  'ReportSharingRequestView',
  T.Object({
    id: T.String(),
    ownerOrgId: T.String(),
    ownerOrgName: T.String(),
    requestingOrgId: T.String(),
    requestingOrgName: T.String(),
    reportId: T.String(),
    reportTitle: T.String(),
    status: SharingStatusView,
    requestedBy: T.String(),
    requestedAt: T.String(),
    decidedBy: T.Union([T.String(), T.Null()]),
    decidedAt: T.Union([T.String(), T.Null()]),
    note: T.Union([T.String(), T.Null()]),
    decisionNote: T.Union([T.String(), T.Null()]),
  }),
);

export const SharedReportSnapshotView = registerSchema(
  'SharedReportSnapshotView',
  T.Object({
    reportId: T.String(),
    title: T.String(),
    reportType: T.String(),
    content: T.Record(T.String(), T.Unknown()),
    generatedAt: T.String(),
    ownerOrgName: T.String(),
    generatedByName: T.Union([T.String(), T.Null()]),
    officerConfirmedBy: T.Union([T.String(), T.Null()]),
    officerConfirmedAt: T.Union([T.String(), T.Null()]),
    reviewedBy: T.Union([T.String(), T.Null()]),
    reviewedAt: T.Union([T.String(), T.Null()]),
  }),
);

// Same lookup-row shapes as sharing.contract.ts's OrgLookupResultView/
// StudyLookupResultView — registered separately per this codebase's
// existing no-cross-module-$ref convention (see sharing.contract.ts's note).
export const ReportSharingOrgLookupResultView = registerSchema(
  'ReportSharingOrgLookupResultView',
  T.Object({
    id: T.String(),
    name: T.String(),
  }),
);

export const ReportLookupResultView = registerSchema(
  'ReportLookupResultView',
  T.Object({
    id: T.String(),
    title: T.String(),
  }),
);
