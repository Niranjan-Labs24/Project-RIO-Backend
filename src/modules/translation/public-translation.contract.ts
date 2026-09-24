import { registerSchema, T, type Static } from '../../contract/typebox';
const id = T.String({ minLength: 1, maxLength: 200 });
export const PublicTranslateBody = registerSchema('PublicTranslateBody', T.Object({
  text: T.String({ minLength: 1, maxLength: 10_000 }),
  targetLocale: T.Union([T.Literal('en'), T.Literal('ar')]),
  scope: T.Union([
    T.Object({ type: T.Literal('reference') }, { additionalProperties: false }),
    T.Object({ type: T.Literal('survey'), token: id }, { additionalProperties: false }),
    T.Object({ type: T.Literal('archive-list') }, { additionalProperties: false }),
    T.Object({ type: T.Literal('archive-detail'), kind: T.Union([T.Literal('report'), T.Literal('historical')]), id }, { additionalProperties: false }),
    T.Object({ type: T.Literal('archive-document'), id }, { additionalProperties: false }),
  ]),
}, { additionalProperties: false }));
export type PublicTranslateDto = Static<typeof PublicTranslateBody>;
