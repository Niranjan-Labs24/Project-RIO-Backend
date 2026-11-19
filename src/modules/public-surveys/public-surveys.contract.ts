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
      // UAT DST-04 — both mandatory, as calendar dates (YYYY-MM-DD) in Riyadh
      // time: the link opens at the start of startsOn and closes at the end
      // of endsOn. Checked against each other and today in the service.
      startsOn: T.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
      endsOn: T.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
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

// UAT DST-01 — send the link to many addresses at once. Each address is
// checked in the service, so one typo is reported instead of failing the lot.
export const ShareSurveyLinkEmailBulkBody = registerSchema(
  'ShareSurveyLinkEmailBulkBody',
  T.Object(
    { emails: T.Array(T.String({ maxLength: 320 }), { minItems: 1, maxItems: 200 }) },
    { additionalProperties: false },
  ),
);
export type ShareSurveyLinkEmailBulkDto = Static<typeof ShareSurveyLinkEmailBulkBody>;
