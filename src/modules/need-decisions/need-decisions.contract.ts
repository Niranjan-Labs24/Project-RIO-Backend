import { registerSchema, T, type Static } from '../../contract/typebox';

export const CreateNeedDecisionBody = registerSchema(
  'CreateNeedDecisionBody',
  T.Object(
    {
      decisionType: T.String({ minLength: 1, maxLength: 100 }),
      // Free text — Q11: not restricted to registered users, since
      // decisions are often assigned to external bodies.
      responsibleParty: T.String({ minLength: 1, maxLength: 300 }),
      // RIO-FR-005 — the decision's own effective date, distinct from the
      // system-generated createdAt timestamp. ISO date string (YYYY-MM-DD).
      decisionDate: T.String({ format: 'date' }),
      notes: T.Optional(T.String({ maxLength: 5000 })),
    },
    { additionalProperties: false },
  ),
);
export type CreateNeedDecisionDto = Static<typeof CreateNeedDecisionBody>;

// UAT PRI-06: edit a decision after it is logged. Status is NOT here — it
// keeps its own route and history (updateStatus). At least one field.
export const UpdateNeedDecisionBody = registerSchema(
  'UpdateNeedDecisionBody',
  T.Object(
    {
      decisionType: T.Optional(T.String({ minLength: 1, maxLength: 100 })),
      responsibleParty: T.Optional(T.String({ minLength: 1, maxLength: 300 })),
      decisionDate: T.Optional(T.String({ format: 'date' })),
      // null or '' clears the notes.
      notes: T.Optional(T.Union([T.String({ maxLength: 5000 }), T.Null()])),
    },
    { additionalProperties: false, minProperties: 1 },
  ),
);
export type UpdateNeedDecisionDto = Static<typeof UpdateNeedDecisionBody>;

export const UpdateNeedDecisionStatusBody = registerSchema(
  'UpdateNeedDecisionStatusBody',
  T.Object(
    {
      status: T.Union([
        T.Literal('open'),
        T.Literal('in_progress'),
        T.Literal('completed'),
        T.Literal('cancelled'),
      ]),
      note: T.Optional(T.String({ maxLength: 2000 })),
    },
    { additionalProperties: false },
  ),
);
export type UpdateNeedDecisionStatusDto = Static<typeof UpdateNeedDecisionStatusBody>;
