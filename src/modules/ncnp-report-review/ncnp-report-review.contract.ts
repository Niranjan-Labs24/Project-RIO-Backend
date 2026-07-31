import { registerSchema, T, type Static } from '../../contract/typebox';

// Reviewer notes are mandatory on both Approve and Reject — client
// requirement, same shape as ApproveSurveyBody/RejectSurveyBody
// (surveys.contract.ts). Whitespace-only strings pass minLength:1 (it
// counts raw characters), so NcnpReportReviewService also runs the shared
// requireNonBlank() trim-check — not expressible in TypeBox alone.
export const ApproveNcnpReportBody = registerSchema(
  'ApproveNcnpReportBody',
  T.Object({
    notes: T.String({ minLength: 1, maxLength: 2000 }),
  }),
);
export type ApproveNcnpReportDto = Static<typeof ApproveNcnpReportBody>;

export const RejectNcnpReportBody = registerSchema(
  'RejectNcnpReportBody',
  T.Object({
    notes: T.String({ minLength: 1, maxLength: 2000 }),
  }),
);
export type RejectNcnpReportDto = Static<typeof RejectNcnpReportBody>;

// Generate takes the same optional period/dormant-window params as
// NcnpReportService.getReport() — the snapshot is generated with whatever
// window System Admin selects.
export const GenerateNcnpReportBody = registerSchema(
  'GenerateNcnpReportBody',
  T.Object({
    periodDays: T.Optional(T.Integer({ minimum: 1 })),
    dormantDays: T.Optional(T.Integer({ minimum: 1 })),
  }),
);
export type GenerateNcnpReportDto = Static<typeof GenerateNcnpReportBody>;
