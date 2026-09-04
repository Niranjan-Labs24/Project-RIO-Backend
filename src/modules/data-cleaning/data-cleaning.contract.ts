import { registerSchema, T, type Static } from '../../contract/typebox';

// RIO-FR-002 — the reviewer queue's request contracts.

export const ListFlagsQuery = registerSchema(
  'ListCleaningFlagsQuery',
  T.Object(
    {
      // Q14's per-source report is a filter on the same queue, not a separate
      // screen: the reviewer works one list and narrows it.
      source: T.Optional(
        T.Union([
          T.Literal('manual_entry'),
          T.Literal('survey_response'),
          T.Literal('file_upload'),
        ]),
      ),
      status: T.Optional(
        T.Union([
          T.Literal('pending'),
          T.Literal('accepted'),
          T.Literal('rejected'),
          T.Literal('superseded'),
        ]),
      ),
      severity: T.Optional(
        T.Union([
          T.Literal('missing'),
          T.Literal('non_standard'),
          T.Literal('out_of_vocabulary'),
        ]),
      ),
      ruleCode: T.Optional(T.String({ maxLength: 60 })),
      studyId: T.Optional(T.String({ format: 'uuid' })),
      // Strings, not Integers, and they have to be declared here rather than
      // taken as separate @Query params: query values arrive as strings and
      // the shared Ajv pipe does not coerce (no coerceTypes), so an Integer
      // schema rejects every paginated request — while `additionalProperties:
      // false` below would reject them for being absent from the schema. A
      // digit pattern still validates them; the controller converts.
      page: T.Optional(T.String({ pattern: '^[1-9][0-9]{0,4}$' })),
      pageSize: T.Optional(T.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    },
    { additionalProperties: false },
  ),
);
export type ListFlagsQueryDto = Static<typeof ListFlagsQuery>;

export const ReviewFlagBody = registerSchema(
  'ReviewCleaningFlagBody',
  T.Object(
    {
      // "accept" applies the proposed value to the record; "reject" records
      // that the stored value is correct as it stands. Both are decisions and
      // both are logged (AC 4) — rejecting is not the same as ignoring, which
      // is why there is no third "dismiss".
      decision: T.Union([T.Literal('accept'), T.Literal('reject')]),
      // Optional on accept, where the proposal itself says what happened.
      // Required on reject in the service, not here: a reviewer overruling the
      // rule set is the case where a future reader needs to know why, and the
      // message for that reads better as a domain error than a schema error.
      note: T.Optional(T.String({ maxLength: 2000 })),
    },
    { additionalProperties: false },
  ),
);
export type ReviewFlagDto = Static<typeof ReviewFlagBody>;

export const BulkAcceptBody = registerSchema(
  'BulkAcceptCleaningFlagsBody',
  T.Object(
    {
      // Bulk accept is scoped to ONE rule code on purpose. A date-format fix
      // lands on hundreds of rows and is the same deterministic change every
      // time; "accept everything pending" would sweep up village near-matches
      // and vocabulary guesses, which are judgements. The UI only offers this
      // for rules whose proposals carry no confidence score.
      ruleCode: T.String({ minLength: 1, maxLength: 60 }),
      source: T.Optional(
        T.Union([
          T.Literal('manual_entry'),
          T.Literal('survey_response'),
          T.Literal('file_upload'),
        ]),
      ),
      note: T.Optional(T.String({ maxLength: 2000 })),
    },
    { additionalProperties: false },
  ),
);
export type BulkAcceptDto = Static<typeof BulkAcceptBody>;

export const ListDuplicatesQuery = registerSchema(
  'ListDuplicateCandidatesQuery',
  T.Object(
    {
      status: T.Optional(
        T.Union([
          T.Literal('pending'),
          T.Literal('confirmed_duplicate'),
          T.Literal('not_duplicate'),
          T.Literal('merged'),
          T.Literal('dismissed'),
        ]),
      ),
      // Q40 — one queue, but the reviewer can narrow to the pass that raised
      // the pair, because a literal match and a semantic one warrant
      // different scrutiny.
      method: T.Optional(T.Union([T.Literal('literal'), T.Literal('semantic')])),
      // Digit strings for the same reason as ListFlagsQuery above.
      page: T.Optional(T.String({ pattern: '^[1-9][0-9]{0,4}$' })),
      pageSize: T.Optional(T.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    },
    { additionalProperties: false },
  ),
);
export type ListDuplicatesQueryDto = Static<typeof ListDuplicatesQuery>;

export const DecideDuplicateBody = registerSchema(
  'DecideDuplicateCandidateBody',
  T.Object(
    {
      // Deliberately no "merge": FR-002 records the decision, and the merge
      // itself is RIO-AI-004 (Q50/Q51 define what has to move with it).
      decision: T.Union([T.Literal('confirmed_duplicate'), T.Literal('not_duplicate')]),
      note: T.Optional(T.String({ maxLength: 2000 })),
    },
    { additionalProperties: false },
  ),
);
export type DecideDuplicateDto = Static<typeof DecideDuplicateBody>;

// ─── RIO-AI-004: merge ─────────────────────────────────────────────────────

export const MergeNeedsBody = registerSchema(
  'MergeNeedsBody',
  T.Object(
    {
      // Which of the pair survives is the REVIEWER's call, not the system's.
      // Neither "the older one" nor "the one with more responses" is right in
      // general — the reviewer knows which entry is the good one.
      survivorNeedId: T.String({ format: 'uuid' }),
      retiredNeedId: T.String({ format: 'uuid' }),
      // Set when the merge came from the duplicate queue, so the candidate can
      // be closed and the merge traced back to what proposed it.
      candidateId: T.Optional(T.String({ format: 'uuid' })),
      note: T.Optional(T.String({ maxLength: 2000 })),
    },
    { additionalProperties: false },
  ),
);
export type MergeNeedsDto = Static<typeof MergeNeedsBody>;

export const UndoMergeBody = registerSchema(
  'UndoMergeBody',
  T.Object(
    {
      // Required, not optional: Q24 asks for a mandatory note on undo, and a
      // CHECK constraint enforces the same thing at the database.
      note: T.String({ minLength: 1, maxLength: 2000 }),
    },
    { additionalProperties: false },
  ),
);
export type UndoMergeDto = Static<typeof UndoMergeBody>;

export const ListMergesQuery = registerSchema(
  'ListMergesQuery',
  T.Object(
    {
      // Digit strings for the same reason as ListFlagsQuery above.
      page: T.Optional(T.String({ pattern: '^[1-9][0-9]{0,4}$' })),
      pageSize: T.Optional(T.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    },
    { additionalProperties: false },
  ),
);
export type ListMergesQueryDto = Static<typeof ListMergesQuery>;

// ─── RIO-FR-002 / Q23: tuning the rule set ─────────────────────────────────

const Threshold = T.Number({ minimum: 0, maximum: 1 });

export const UpdateCleaningSettingsBody = registerSchema(
  'UpdateCleaningSettingsBody',
  T.Object(
    {
      // Every field optional: the screen patches what changed, and sending a
      // partial must never reset the thresholds it did not touch.
      dontKnowTreatment: T.Optional(
        T.Union([T.Literal('excluded_answer'), T.Literal('missing_value')]),
      ),
      villageMatchAcceptThreshold: T.Optional(Threshold),
      villageMatchProposeThreshold: T.Optional(Threshold),
      villageMatchMaxCandidates: T.Optional(T.Integer({ minimum: 1, maximum: 20 })),
      literalDuplicateThreshold: T.Optional(Threshold),
      classificationNearMatchThreshold: T.Optional(Threshold),
      semanticDuplicateThreshold: T.Optional(Threshold),
      requiredNeedFields: T.Optional(T.Array(T.String({ maxLength: 60 }), { maxItems: 20 })),
      softNeedFields: T.Optional(T.Array(T.String({ maxLength: 60 }), { maxItems: 20 })),
      duplicateScopes: T.Optional(
        T.Object(
          {
            withinStudy: T.Optional(T.Boolean()),
            withinOrg: T.Optional(T.Boolean()),
            // crossOrg stays here for completeness; RIO-AI-004 is what
            // actually generates cross-entity candidates, and Q9 confines
            // seeing them to the Center/NCNP role.
            crossOrg: T.Optional(T.Boolean()),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
);
export type UpdateCleaningSettingsDto = Static<typeof UpdateCleaningSettingsBody>;
