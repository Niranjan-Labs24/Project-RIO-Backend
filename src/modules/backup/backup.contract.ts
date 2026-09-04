import { registerSchema, T, type Static } from '../../contract/typebox';

// RIO-NFR-010 — the backup administration contracts.

export const ListBackupRunsQuery = registerSchema(
  'ListBackupRunsQuery',
  T.Object(
    {
      kind: T.Optional(T.Union([T.Literal('database'), T.Literal('attachments')])),
      status: T.Optional(
        T.Union([T.Literal('running'), T.Literal('succeeded'), T.Literal('failed')]),
      ),
      // Digit strings rather than Integers, matching the other list contracts:
      // query parameters arrive as strings and the validation pipe does not
      // coerce, so an Integer schema would reject every real request. The
      // controller converts.
      page: T.Optional(T.String({ pattern: '^[0-9]+$' })),
      pageSize: T.Optional(T.String({ pattern: '^[0-9]+$' })),
    },
    { additionalProperties: false },
  ),
);
export type ListBackupRunsQueryDto = Static<typeof ListBackupRunsQuery>;

export const TriggerBackupBody = registerSchema(
  'TriggerBackupBody',
  T.Object(
    {
      // No default: an administrator triggering a backup by hand should say
      // which one they mean. The scheduled run takes both.
      kind: T.Union([T.Literal('database'), T.Literal('attachments')]),
    },
    { additionalProperties: false },
  ),
);
export type TriggerBackupDto = Static<typeof TriggerBackupBody>;
