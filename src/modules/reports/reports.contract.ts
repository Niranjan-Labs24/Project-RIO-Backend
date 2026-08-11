import { registerSchema, T, type Static } from "../../contract/typebox";
import { REPORT_TYPES } from "./reports.types";

const ReportTypeEnum = T.Union(REPORT_TYPES.map((code) => T.Literal(code)));

export const CreateReportBody = registerSchema(
  "CreateReportBody",
  T.Object(
    {
      reportType: ReportTypeEnum,
      studyId: T.Optional(T.String({ format: "uuid" })),
      // Survey-scoped types only (RPT01/RPT15) — required for those, rejected
      // as an unused field for the rest. See ReportsService.create.
      surveyId: T.Optional(T.String({ format: "uuid" })),
      filters: T.Optional(T.Record(T.String(), T.Unknown())),
    },
    { additionalProperties: false },
  ),
);
export type CreateReportDto = Static<typeof CreateReportBody>;

// Reviewer notes mandatory on both Approve and Reject — client requirement
// (RIO-FR-007 clarification, Aug 4: extend the mandatory-notes rule from the
// NCNP Compiled Report to all four report categories). Same shape as
// ApproveNcnpReportBody/RejectNcnpReportBody. Whitespace-only strings pass
// minLength:1 (raw character count) — ReportsService also runs the shared
// requireNonBlank() trim-check.
export const ApproveReportBody = registerSchema(
  "ApproveReportBody",
  T.Object({
    notes: T.String({ minLength: 1, maxLength: 2000 }),
  }),
);
export type ApproveReportDto = Static<typeof ApproveReportBody>;

export const RejectReportBody = registerSchema(
  "RejectReportBody",
  T.Object({
    notes: T.String({ minLength: 1, maxLength: 2000 }),
  }),
);
export type RejectReportDto = Static<typeof RejectReportBody>;
