import { registerSchema, T, type Static } from '../../contract/typebox';

const InitiativeFields = {
  name: T.String({ minLength: 1, maxLength: 300 }),
  domain: T.Optional(T.String({ maxLength: 120 })),
  geography: T.Optional(T.String({ maxLength: 2000 })),
  startDate: T.Optional(T.String({ format: 'date' })),
  expectedEndDate: T.Optional(T.String({ format: 'date' })),
  status: T.Optional(T.String({ maxLength: 30 })),
  fundingSource: T.Optional(T.String({ maxLength: 200 })),
  description: T.Optional(T.String({ maxLength: 5000 })),
  // Optional per client Q16 — not required, at least for Sprint 3.
  budget: T.Optional(T.Number({ minimum: 0 })),
  openToOtherEntities: T.Optional(T.Boolean()),
};

export const CreateInitiativeBody = registerSchema(
  'CreateInitiativeBody',
  T.Object({ ...InitiativeFields, name: InitiativeFields.name }, { additionalProperties: false }),
);
export type CreateInitiativeDto = Static<typeof CreateInitiativeBody>;

export const UpdateInitiativeBody = registerSchema(
  'UpdateInitiativeBody',
  T.Object(
    { ...InitiativeFields, name: T.Optional(InitiativeFields.name) },
    { additionalProperties: false },
  ),
);
export type UpdateInitiativeDto = Static<typeof UpdateInitiativeBody>;
