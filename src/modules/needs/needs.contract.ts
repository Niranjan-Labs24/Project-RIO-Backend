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
    },
    { additionalProperties: false },
  ),
);
export type UpdateNeedDto = Static<typeof UpdateNeedBody>;
