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
      // Manual, authoritative Domain Category — mandatory on the
      // manual-entry form (see NeedsService.create). Not required on the
      // bulk CSV import path (NeedsImportService writes directly via
      // Prisma, bypassing this contract) — an imported Need can still be
      // set here later while it's editable (draft).
      domain: T.String({ minLength: 1, maxLength: 120 }),
      subDomain: T.String({ minLength: 1, maxLength: 120 }),
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
      domain: T.Optional(T.String({ minLength: 1, maxLength: 120 })),
      subDomain: T.Optional(T.String({ minLength: 1, maxLength: 120 })),
      referenceId: T.Optional(T.Union([T.String({ maxLength: 200 }), T.Null()])),
    },
    { additionalProperties: false },
  ),
);
export type UpdateNeedDto = Static<typeof UpdateNeedBody>;
