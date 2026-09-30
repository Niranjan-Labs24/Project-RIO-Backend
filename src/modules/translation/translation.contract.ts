import { registerSchema, T, type Static } from '../../contract/typebox';

// A single free-text string plus which language it needs to end up in.
// `sourceLocale` is optional by design — TranslationService detects it from
// the text's own script when omitted; callers only pass it when they
// already know for certain (see TranslateContentPayload's own comment).
export const TranslateContentBody = registerSchema(
  'TranslateContentBody',
  T.Object(
    {
      text: T.String({ minLength: 1, maxLength: 10_000 }),
      targetLocale: T.Union([T.Literal('en'), T.Literal('ar')]),
      sourceLocale: T.Optional(T.Union([T.Literal('en'), T.Literal('ar')])),
    },
    { additionalProperties: false },
  ),
);
export type TranslateContentDto = Static<typeof TranslateContentBody>;

// One page's worth of strings in a single request — a report screen renders
// hundreds of translatable values, and one request per value ran straight
// into the per-user rate limit (300/min), so the page sat on a loader for a
// minute or two while requests queued behind 429s.
export const TranslateBatchBody = registerSchema(
  'TranslateBatchBody',
  T.Object(
    {
      texts: T.Array(T.String({ minLength: 1, maxLength: 10_000 }), { minItems: 1, maxItems: 400 }),
      targetLocale: T.Union([T.Literal('en'), T.Literal('ar')]),
    },
    { additionalProperties: false },
  ),
);
export type TranslateBatchDto = Static<typeof TranslateBatchBody>;
