import { registerSchema, T, type Static } from '../../contract/typebox';

export const CreateNoteBody = registerSchema(
  'CreateNoteBody',
  T.Object({ body: T.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }),
);

export type CreateNoteDto = Static<typeof CreateNoteBody>;

export interface NoteView {
  id: string;
  body: string;
  createdAt: string;
}
