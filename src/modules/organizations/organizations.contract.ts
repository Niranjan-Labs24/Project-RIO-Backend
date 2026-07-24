import { registerSchema, T, type Static } from '../../contract/typebox';

// Not a fixed enum: `sector` is validated against the live, active Domain
// list from Methodology Configuration (see OrganizationsService/AuthService
// — DomainsService.listDomains()), or the literal "other". TypeBox can't
// express "one of these dynamic values" at the schema level, so this only
// checks shape/length here; the real check happens in the service.
const SectorValue = T.String({ minLength: 1, maxLength: 200 });

// Shared array-of-strings shape for both `villages` and `region` — an org
// (or a Need, see needs.contract.ts) can span more than one of either, not
// a single comma-separated string.
const Villages = T.Array(T.String({ minLength: 1, maxLength: 200 }), { maxItems: 2000 });

// Nullable + optional (a PATCH may clear a field to null or omit it). Unknown
// properties are permitted (forward-compatible with the FE) but every known
// field is type/length/enum checked, so bad input is a 400 — not a Prisma 500.
export const UpdateOrganizationBody = registerSchema(
  'UpdateOrganizationBody',
  T.Object({
    name: T.Optional(T.String({ minLength: 1, maxLength: 200 })),
    region: T.Optional(Villages),
    email: T.Optional(T.Union([T.String({ format: 'email', maxLength: 320 }), T.Null()])),
    sector: T.Optional(T.Union([SectorValue, T.Null()])),
    // Only meaningful when `sector` is `'other'` — the org's own free-text
    // description of what that is (see Settings > Organization's
    // sector/"specify other" pattern, and signup-form.tsx's identical one).
    purpose: T.Optional(T.Union([T.String({ maxLength: 500 }), T.Null()])),
    // The frontend currently uploads a logo as a base64 data URI (no object
    // storage yet), not a short hosted URL — 2048 chars fit neither.
    // 2.8M chars comfortably covers a 2MB raw image (base64 runs ~33%
    // larger than raw bytes, so 2MB -> ~2.7M chars) — the frontend's own
    // client-side size cap (see signup-form.tsx) — while staying under
    // main.ts's 3mb JSON body-parser limit. `logo_url` itself is an
    // unconstrained Postgres TEXT column, so only this app-level cap
    // matters. Revisit (both this and the 2MB client cap) once uploads go
    // through real object storage (S3/GCS/etc.) and this becomes a short
    // URL again.
    logoUrl: T.Optional(T.Union([T.String({ maxLength: 2_800_000 }), T.Null()])),
    villages: T.Optional(Villages),
    // Optional link into the KSA Geographic Reference master data — see
    // GeographyService#validateHierarchy for the actual existence/hierarchy
    // checks TypeBox can't express (every id must exist, and every selected
    // Governorate/Center must belong to the selected Region/Governorates).
    // `regionId` is single-select (an org has exactly one Region); `governorateIds`/
    // `centerIds` replace the entire set when provided, not a merge.
    regionId: T.Optional(T.Union([T.String({ format: 'uuid' }), T.Null()])),
    governorateIds: T.Optional(T.Array(T.String({ format: 'uuid' }), { maxItems: 150 })),
    centerIds: T.Optional(T.Array(T.String({ format: 'uuid' }), { maxItems: 1404 })),
    isActive: T.Optional(T.Boolean()),
  }),
);
export type UpdateOrganizationDto = Static<typeof UpdateOrganizationBody>;

export const CreateOrganizationBody = registerSchema(
  'CreateOrganizationBody',
  T.Object({
    name: T.String({ minLength: 1, maxLength: 200 }),
    purpose: T.String({ minLength: 1, maxLength: 500 }),
    registrationNumber: T.String({ minLength: 1, maxLength: 100 }),
    region: T.Optional(Villages),
    email: T.Optional(T.Union([T.String({ format: 'email', maxLength: 320 }), T.Null()])),
    sector: T.Optional(T.Union([SectorValue, T.Null()])),
    villages: T.Optional(Villages),
    adminName: T.String({ minLength: 1, maxLength: 200 }),
    adminEmail: T.String({ format: 'email', maxLength: 320 }),
  }),
);
export type CreateOrganizationDto = Static<typeof CreateOrganizationBody>;
