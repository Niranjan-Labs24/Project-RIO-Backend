import { registerSchema, T, type Static } from '../../contract/typebox';

// Deliberately narrow. The citizen page may tell the server WHERE a
// respondent got to and HOW MANY questions had a value — never which
// questions, and never what was entered. There is no free-text field in this
// contract at all, which is what makes "no partial answer data is persisted"
// (client answer, 24 Aug) enforceable at the edge rather than by convention.
export const RecordSessionEventBody = registerSchema(
  'RecordSessionEventBody',
  T.Object(
    {
      step: T.Union([
        T.Literal('OPENED'),
        T.Literal('DETAILS'),
        T.Literal('OTP_REQUESTED'),
        T.Literal('OTP_VERIFIED'),
        T.Literal('ANSWERING'),
        T.Literal('REVIEW'),
        // SUBMITTED is set by the server on the real submission (see
        // SurveySessionsService.markSubmitted) and is not client-assertable —
        // a session must never be able to claim a submission that produced no
        // SurveyResponse row.
      ]),
      position: T.Optional(T.Integer({ minimum: 0, maximum: 10_000 })),
      answeredCount: T.Optional(T.Integer({ minimum: 0, maximum: 10_000 })),
    },
    { additionalProperties: false },
  ),
);
export type RecordSessionEventDto = Static<typeof RecordSessionEventBody>;
