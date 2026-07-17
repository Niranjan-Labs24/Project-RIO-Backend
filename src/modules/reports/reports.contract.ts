import { registerSchema, T, type Static } from "../../contract/typebox";
import { REPORT_TYPES } from "./reports.types";

const ReportTypeEnum = T.Union(REPORT_TYPES.map((code) => T.Literal(code)));

export const CreateReportBody = registerSchema(
  "CreateReportBody",
  T.Object(
    {
      reportType: ReportTypeEnum,
      studyId: T.Optional(T.String({ format: "uuid" })),
      filters: T.Optional(T.Record(T.String(), T.Unknown())),
    },
    { additionalProperties: false },
  ),
);
export type CreateReportDto = Static<typeof CreateReportBody>;
