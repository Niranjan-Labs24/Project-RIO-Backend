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

const ScopeLevel = T.Union([
  T.Literal('KINGDOM'),
  T.Literal('REGION'),
  T.Literal('GOVERNORATE'),
  T.Literal('CENTRE'),
  T.Literal('VILLAGE'),
]);

// NCNP needs report (client, 7 Oct 2026, point 2): the Core Needs Report for a
// scope and domains, combining the selected studies across organisations.
export const GenerateNcnpNeedsBody = registerSchema(
  'GenerateNcnpNeedsBody',
  T.Object(
    {
      scopeLevel: ScopeLevel,
      unitId: T.Optional(T.Union([T.String({ minLength: 1, maxLength: 200 }), T.Null()])),
      domainKeys: T.Optional(T.Array(T.String({ minLength: 1, maxLength: 120 }), { maxItems: 20 })),
      studyIds: T.Array(T.String({ format: 'uuid' }), { minItems: 1, maxItems: 50 }),
      output: T.Optional(T.Union([T.Literal('FULL'), T.Literal('SUMMARY')])),
    },
    { additionalProperties: false },
  ),
);
export type GenerateNcnpNeedsDto = Static<typeof GenerateNcnpNeedsBody>;
