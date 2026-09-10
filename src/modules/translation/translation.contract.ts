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
