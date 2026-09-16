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
