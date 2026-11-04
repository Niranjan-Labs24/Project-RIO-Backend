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
      // UAT DST-04 — start and end dates are mandatory (YYYY-MM-DD, Saudi
      // calendar days, end date included). Replaces the optional
      // `expiresInDays` (omitted = never expires). Window rules live in
      // resolveSurveyLinkWindow (survey-link-window.ts).
      startDate: T.String({ format: 'date' }),
      endDate: T.String({ format: 'date' }),
    },
    { additionalProperties: false },
  ),
);
export type CreateSurveyLinkDto = Static<typeof CreateSurveyLinkBody>;

export const ShareSurveyLinkEmailBody = registerSchema(
  'ShareSurveyLinkEmailBody',
  T.Object(
    { email: T.String({ format: 'email', maxLength: 320 }) },
    { additionalProperties: false },
  ),
);
export type ShareSurveyLinkEmailDto = Static<typeof ShareSurveyLinkEmailBody>;
