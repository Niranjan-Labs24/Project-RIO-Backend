import { registerSchema, T, type Static } from "../../contract/typebox";

export const CreateReportSharingRequestBody = registerSchema(
  "CreateReportSharingRequestBody",
  T.Object(
    {
      ownerOrgId: T.String({ format: "uuid" }),
      reportId: T.String({ format: "uuid" }),
      note: T.Optional(T.String({ maxLength: 1000 })),
    },
    { additionalProperties: false },
  ),
);
export type CreateReportSharingRequestDto = Static<typeof CreateReportSharingRequestBody>;

// Optional reason on approve/reject — see ReportSharingRequest.decisionNote.
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
