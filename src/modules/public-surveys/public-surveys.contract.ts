import { registerSchema, T, type Static } from '../../contract/typebox';

export const CreateSurveyLinkBody = registerSchema(
  'CreateSurveyLinkBody',
  T.Object(
    {
      // Required, max 150 chars, and must contain at least one non-whitespace
      // character (the `\S` pattern) so an all-whitespace label is rejected
      // here rather than silently becoming "" after the service trims it.
      // Per-Study uniqueness is enforced at the DB level (see the
      // PublicSurveyLink.@@unique([studyId, label]) schema comment) — a
      // TypeBox schema has no notion of "unique within this Study".
      label: T.String({ minLength: 1, maxLength: 150, pattern: '\\S' }),
      // Omitted = no expiry. RIO-NFR-014-style configurability: callers pick
      // the window per link rather than a single hardcoded TTL.
      expiresInDays: T.Optional(T.Integer({ minimum: 1, maximum: 365 })),
    },
    { additionalProperties: false },
  ),
);
export type CreateSurveyLinkDto = Static<typeof CreateSurveyLinkBody>;
