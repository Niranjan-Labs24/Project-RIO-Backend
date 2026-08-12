import { registerSchema, T, type Static } from '../../contract/typebox';

// Same shape as Organisation's own `villages` field (organizations.contract.ts) —
// selected from the org's configured villages, or a new one added inline.
const Villages = T.Array(T.String({ minLength: 1, maxLength: 200 }), { maxItems: 2000 });

// Mandatory multi-select — must each be one of the Organization's own
// selected Governorates/Centers (see StudiesService for the actual
// existence/hierarchy/org-scope checks TypeBox can't express). Non-empty:
// a Study must scope itself to at least one of each.
const GovernorateIds = T.Array(T.String({ format: 'uuid' }), { minItems: 1, maxItems: 200 });
const CenterIds = T.Array(T.String({ format: 'uuid' }), { minItems: 1, maxItems: 1404 });

// Mandatory link to the real, status-gated MethodologyVersion master data
// (see priority module) — a Study must bind to one at creation; only a
// PUBLISHED version may be selected (checked in StudiesService, not
// enforceable by TypeBox).
const MethodologyVersionId = T.String({ format: 'uuid' });

// RIO-FR-024: "What is the population of your area?" — asked at study
// creation so the required sample size and MDE can be computed and stored
// immediately (see StudiesService/sample-size.ts). marginOfError defaults
// to ±10% (the signed-off default) but is configurable per study.
const Population = T.Integer({ minimum: 1 });
const MarginOfError = T.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 });

export const CreateStudyBody = registerSchema(
  'CreateStudyBody',
  T.Object(
    {
      title: T.String({ minLength: 1, maxLength: 300 }),
      villages: T.Optional(Villages),
      governorateIds: GovernorateIds,
      centerIds: CenterIds,
      methodologyVersionId: MethodologyVersionId,
      population: Population,
      marginOfError: T.Optional(MarginOfError),
    },
    { additionalProperties: false },
  ),
);
export type CreateStudyDto = Static<typeof CreateStudyBody>;

// Title, villages, governorateIds, centerIds, and methodologyVersionId are
// the only Study-level fields a user edits directly — status only ever
// advances through the Need/Evidence/AI Classification/Human Review
// workflow, never a direct PATCH. cycleNumber is never client-writable
// (server-assigned once at creation, immutable after).
export const UpdateStudyBody = registerSchema(
  'UpdateStudyBody',
  T.Object(
    {
      title: T.Optional(T.String({ minLength: 1, maxLength: 300 })),
      villages: T.Optional(Villages),
      governorateIds: T.Optional(GovernorateIds),
      centerIds: T.Optional(CenterIds),
      methodologyVersionId: T.Optional(MethodologyVersionId),
    },
    { additionalProperties: false },
  ),
);
export type UpdateStudyDto = Static<typeof UpdateStudyBody>;
