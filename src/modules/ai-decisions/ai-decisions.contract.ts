import { registerSchema, T, type Static } from '../../contract/typebox';

export const ReviewDecisionBody = registerSchema(
  'ReviewDecisionBody',
  T.Object(
    {
      decision: T.Union([T.Literal('approved'), T.Literal('rejected'), T.Literal('modified')]),
      notes: T.Optional(T.String({ maxLength: 2000 })),
      overrideValue: T.Optional(T.Unknown()),
    },
    { additionalProperties: false },
  ),
);
export type ReviewDecisionDto = Static<typeof ReviewDecisionBody>;

// A Need can span multiple Domain/Sub-domain pairs (see NeedDomain) — every
// override/manual-classify payload carries an array of these instead of a
// single {domain, subDomain}, no limit on how many.
const DomainSubDomainPair = T.Object({
  domain: T.String({ minLength: 1 }),
  subDomain: T.String({ minLength: 1 }),
});

// Approve here only decides the classification (Override + Approve) — it
// no longer touches the survey's question list or publishes it. Curating
// questions (Question Bank + AI-suggested + open-ended) and Submit for
// Approval / Approve & Publish all happen separately, on the Survey Builder
// page, once this need is `reviewer_approved` (see SurveysController).
export const AiReviewApproveBody = registerSchema(
  'AiReviewApproveBody',
  T.Object(
    {
      domainOverride: T.Optional(
        T.Object({
          pairs: T.Array(DomainSubDomainPair, { minItems: 1 }),
          reason: T.String({ minLength: 1, maxLength: 2000 }),
        }),
      ),
    },
    { additionalProperties: false },
  ),
);
export type AiReviewApproveDto = Static<typeof AiReviewApproveBody>;

export const AiReviewRejectBody = registerSchema(
  'AiReviewRejectBody',
  T.Object(
    { comments: T.String({ minLength: 1, maxLength: 2000 }) },
    { additionalProperties: false },
  ),
);
export type AiReviewRejectDto = Static<typeof AiReviewRejectBody>;

export const AiReviewOverrideDomainBody = registerSchema(
  'AiReviewOverrideDomainBody',
  T.Object(
    {
      pairs: T.Array(DomainSubDomainPair, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
);
export type AiReviewOverrideDomainDto = Static<typeof AiReviewOverrideDomainBody>;
