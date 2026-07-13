import { registerSchema, T, type Static } from '../../contract/typebox';

// Sector enum mirrors prisma `Sector` (and the FE contract, lowercase).
const SectorEnum = T.Union([
  T.Literal('education'),
  T.Literal('healthcare'),
  T.Literal('agriculture'),
  T.Literal('wash'),
  T.Literal('livelihoods'),
  T.Literal('disaster_relief'),
  T.Literal('other'),
]);

const Villages = T.Array(T.String({ minLength: 1, maxLength: 200 }), { maxItems: 2000 });

// Nullable + optional (a PATCH may clear a field to null or omit it). Unknown
// properties are permitted (forward-compatible with the FE) but every known
// field is type/length/enum checked, so bad input is a 400 — not a Prisma 500.
export const UpdateOrganizationBody = registerSchema(
  'UpdateOrganizationBody',
  T.Object({
    name: T.Optional(T.String({ minLength: 1, maxLength: 200 })),
    region: T.Optional(T.Union([T.String({ maxLength: 200 }), T.Null()])),
    email: T.Optional(T.Union([T.String({ format: 'email', maxLength: 320 }), T.Null()])),
    sector: T.Optional(T.Union([SectorEnum, T.Null()])),
    logoUrl: T.Optional(T.Union([T.String({ maxLength: 2048 }), T.Null()])),
    villages: T.Optional(Villages),
    isActive: T.Optional(T.Boolean()),
  }),
);
export type UpdateOrganizationDto = Static<typeof UpdateOrganizationBody>;

export const CreateOrganizationBody = registerSchema(
  'CreateOrganizationBody',
  T.Object({
    name: T.String({ minLength: 1, maxLength: 200 }),
    region: T.Optional(T.Union([T.String({ maxLength: 200 }), T.Null()])),
    email: T.Optional(T.Union([T.String({ format: 'email', maxLength: 320 }), T.Null()])),
    sector: T.Optional(T.Union([SectorEnum, T.Null()])),
    villages: T.Optional(Villages),
    adminName: T.String({ minLength: 1, maxLength: 200 }),
    adminEmail: T.String({ format: 'email', maxLength: 320 }),
  }),
);
export type CreateOrganizationDto = Static<typeof CreateOrganizationBody>;
