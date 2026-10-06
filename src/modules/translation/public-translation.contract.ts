import { registerSchema, T, type Static } from '../../contract/typebox';
const id = T.String({ minLength: 1, maxLength: 200 });
const scope = T.Union([
  T.Object({ type: T.Literal('reference') }, { additionalProperties: false }),
  T.Object({ type: T.Literal('survey'), token: id }, { additionalProperties: false }),
  T.Object({ type: T.Literal('archive-list') }, { additionalProperties: false }),
  T.Object(
    {
      type: T.Literal('archive-detail'),
      kind: T.Union([T.Literal('report'), T.Literal('historical')]),
      id,
    },
    { additionalProperties: false },
  ),
  T.Object({ type: T.Literal('archive-document'), id }, { additionalProperties: false }),
]);
export const PublicTranslateBody = registerSchema(
  'PublicTranslateBody',
  T.Object(
    {
      text: T.String({ minLength: 1, maxLength: 10_000 }),
      targetLocale: T.Union([T.Literal('en'), T.Literal('ar')]),
      scope,
    },
    { additionalProperties: false },
  ),
);
export type PublicTranslateDto = Static<typeof PublicTranslateBody>;
export type PublicTranslationScope = PublicTranslateDto['scope'];

// A whole public page's strings at once. A published report holds several
// hundred strings, and one request each ran into the per-minute limit, so
// about half the page stayed in English. Unauthenticated, so the work one
// request can cause is bounded here, by total characters in the service and
// by a per-IP character budget (PR #84 review).
export const PUBLIC_BATCH_MAX_ITEMS = 100;
export const PublicTranslateBatchBody = registerSchema(
  'PublicTranslateBatchBody',
  T.Object(
    {
      texts: T.Array(T.String({ minLength: 1, maxLength: 5_000 }), {
        minItems: 1,
        maxItems: PUBLIC_BATCH_MAX_ITEMS,
      }),
      targetLocale: T.Union([T.Literal('en'), T.Literal('ar')]),
      scope,
    },
    { additionalProperties: false },
  ),
);
export type PublicTranslateBatchDto = Static<typeof PublicTranslateBatchBody>;
