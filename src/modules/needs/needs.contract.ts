import { registerSchema, T, type Static } from '../../contract/typebox';

// A Need can name more than one village — same array-of-strings shape as
// Organisation.villages/region (see organizations.contract.ts). Optional:
// a Need is scoped by its structured Governorate/Centers, village is just
// an additional free-text detail when the submitter happens to know it.
const Villages = T.Array(T.String({ minLength: 1, maxLength: 200 }), { maxItems: 200 });

// Optional multi-select link into the KSA Geographic Reference master data
// — see NeedsService for the actual existence/hierarchy/Study-scope checks
// TypeBox can't express. A single Need can span multiple Governorates/
// Centers (mirrors the Organization's/Study's own multi-select).
const GovernorateIds = T.Array(T.String({ format: 'uuid' }), { maxItems: 150 });
const CenterIds = T.Array(T.String({ format: 'uuid' }), { maxItems: 1404 });

// "Roughly how many people does this need affect?" — the field researcher's
// own estimate, captured at need entry (client-confirmed Option A). Optional:
// an estimate nobody is confident in is worth less than an honest blank, and
// the report prints a dash and says why rather than inventing a figure.
// Integer >= 0; the upper bound is Saudi Arabia's population rounded up, which
// catches a mistyped digit run without rejecting any real answer.
const AffectedPopulation = T.Integer({ minimum: 0, maximum: 50_000_000 });

export const CreateNeedBody = registerSchema(
  'CreateNeedBody',
  T.Object(
    {
      // Optional — NeedsService.create() derives a fallback from the
      // statement when omitted/blank, so a Need never ends up with no
      // display title even though the field itself isn't mandatory.
      title: T.Optional(T.String({ maxLength: 300 })),
      statement: T.String({ minLength: 1, maxLength: 5000 }),
      village: T.Optional(Villages),
      governorateIds: T.Optional(GovernorateIds),
      centerIds: T.Optional(CenterIds),
      // The submitter's own external tracking id (a field form number, a
      // partner org's case id, etc.) — free text, never validated.
      referenceId: T.Optional(T.String({ maxLength: 200 })),
      affectedPopulation: T.Optional(AffectedPopulation),
      // RIO-FR-005 (Round 4, client-confirmed 2026-08-24) — "Roughly how
      // many people/households does this need affect?" This manually
      // entered figure is the PRIMARY Affected Population value (see
      // schema.prisma's comment on Need.affectedPeople/affectedHouseholds
      // for why no GASTAT-derived value is offered here yet).
      affectedPeople: T.Optional(T.Integer({ minimum: 0 })),
      affectedHouseholds: T.Optional(T.Integer({ minimum: 0 })),
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
      governorateIds: T.Optional(GovernorateIds),
      centerIds: T.Optional(CenterIds),
      referenceId: T.Optional(T.Union([T.String({ maxLength: 200 }), T.Null()])),
      // Null is a real value here, not "leave alone" — it clears an estimate
      // that turned out to be wrong. Omitting the key leaves it untouched.
      affectedPopulation: T.Optional(T.Union([AffectedPopulation, T.Null()])),
      affectedPeople: T.Optional(T.Union([T.Integer({ minimum: 0 }), T.Null()])),
      affectedHouseholds: T.Optional(T.Union([T.Integer({ minimum: 0 }), T.Null()])),
    },
    { additionalProperties: false },
  ),
);
export type UpdateNeedDto = Static<typeof UpdateNeedBody>;

// RIO-FR-005 (Q12, client-confirmed) — five fixed values, final, no
// additions. Analyst-entered, never auto-calculated (see schema.prisma's
// comment on Need.gapType).
export const GAP_TYPES = ['acute', 'chronic', 'structural', 'seasonal', 'equity'] as const;

export const SetNeedGapTypeBody = registerSchema(
  'SetNeedGapTypeBody',
  T.Object(
    { gapType: T.Union([T.Literal('acute'), T.Literal('chronic'), T.Literal('structural'), T.Literal('seasonal'), T.Literal('equity'), T.Null()]) },
    { additionalProperties: false },
  ),
);
export type SetNeedGapTypeDto = Static<typeof SetNeedGapTypeBody>;

export const BulkImportNeedsBody = registerSchema(
  'BulkImportNeedsBody',
  T.Object(
    {
      needs: T.Array(
        T.Object({
          title: T.String({ minLength: 1, maxLength: 300 }),
          statement: T.String({ minLength: 1, maxLength: 5000 }),
          village: T.Optional(T.String({ maxLength: 500 })),
          referenceId: T.Optional(T.String({ maxLength: 200 })),
          affectedPopulation: T.Optional(AffectedPopulation),
        }),
        { maxItems: 2000 },
      ),
    },
    { additionalProperties: false },
  ),
);
export type BulkImportNeedsDto = Static<typeof BulkImportNeedsBody>;
