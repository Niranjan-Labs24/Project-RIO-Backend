import { registerSchema, T, type Static } from '../../contract/typebox';

// The reviewer's edited text. Upper bound is needs.contract.ts's own cap on
// `statement`: a "summary" longer than the longest possible source is never a
// summary, and the per-config maxSummaryChars sits far below this. This is the
// hard contract ceiling, not the methodology limit.
export const UpdateNeedSummaryBody = registerSchema(
  'UpdateNeedSummaryBody',
  T.Object(
    {
      summaryText: T.String({ minLength: 1, maxLength: 5000 }),
    },
    { additionalProperties: false },
  ),
);
export type UpdateNeedSummaryDto = Static<typeof UpdateNeedSummaryBody>;

// Bulk confirm from the reviewer queue. Capped at 200 to match the platform's
// list-endpoint page cap (RIO-NFR-006) — a reviewer can only be looking at one
// page, so a larger batch would not have come from the UI.
export const ConfirmNeedSummariesBody = registerSchema(
  'ConfirmNeedSummariesBody',
  T.Object(
    {
      summaryIds: T.Array(T.String({ format: 'uuid' }), { minItems: 1, maxItems: 200 }),
    },
    { additionalProperties: false },
  ),
);
export type ConfirmNeedSummariesDto = Static<typeof ConfirmNeedSummariesBody>;
