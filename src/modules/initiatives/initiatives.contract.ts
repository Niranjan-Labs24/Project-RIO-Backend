import { registerSchema, T, type Static } from '../../contract/typebox';
import { SUPPORTED_CURRENCIES } from './initiatives.types';

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
  // Client feedback 2026-09-07 — defaults to SAR server-side when omitted
  // (see InitiativesService.create).
  currency: T.Optional(T.Union(SUPPORTED_CURRENCIES.map((c) => T.Literal(c)))),
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
