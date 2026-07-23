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
