import { registerSchema, T, type Static } from '../../contract/typebox';

// A Need can name more than one village — same array-of-strings shape as
// Organisation.villages/region (see organizations.contract.ts).
const Villages = T.Array(T.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 200 });

export const CreateNeedBody = registerSchema(
  'CreateNeedBody',
  T.Object(
    {
      title: T.String({ minLength: 1, maxLength: 300 }),
      statement: T.String({ minLength: 1, maxLength: 5000 }),
      village: Villages,
      // e.g. "Field Survey", "Community Meeting" — the submitter's own
      // description of where this Need came from. Defaults to "Manual
      // Entry" server-side if omitted (see NeedsService.create).
      source: T.Optional(T.String({ minLength: 1, maxLength: 200 })),
      // The submitter's own external tracking id (a field form number, a
      // partner org's case id, etc.) — free text, never validated.
      referenceId: T.Optional(T.String({ maxLength: 200 })),
    },
    { additionalProperties: false },
  ),
);
export type CreateNeedDto = Static<typeof CreateNeedBody>;

export const UpdateNeedBody = registerSchema(
  'UpdateNeedBody',
  T.Object(
    {
      title: T.Optional(T.String({ minLength: 1, maxLength: 300 })),
      statement: T.Optional(T.String({ minLength: 1, maxLength: 5000 })),
      village: T.Optional(Villages),
      source: T.Optional(T.String({ minLength: 1, maxLength: 200 })),
      referenceId: T.Optional(T.Union([T.String({ maxLength: 200 }), T.Null()])),
    },
    { additionalProperties: false },
  ),
);
export type UpdateNeedDto = Static<typeof UpdateNeedBody>;
