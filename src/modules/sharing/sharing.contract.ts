import { registerSchema, T, type Static } from "../../contract/typebox";

export const CreateSharingRequestBody = registerSchema(
  "CreateSharingRequestBody",
  T.Object(
    {
      ownerOrgId: T.String({ format: "uuid" }),
      studyId: T.String({ format: "uuid" }),
      // "Purpose" in the UI — required so the owning org always has business
      // context to decide against, not just "Request for Study X". Field
      // stays named `note` end-to-end (DB column, audit trail) to avoid an
      // unrelated rename; only the label/requiredness changed.
      note: T.String({ minLength: 1, maxLength: 1000 }),
    },
    { additionalProperties: false },
  ),
);
export type CreateSharingRequestDto = Static<typeof CreateSharingRequestBody>;

// Optional at the schema level (an approve never needs a reason) — reject
// requires a non-empty note, enforced in SharingService.decide() since
// that's a cross-field rule TypeBox can't express here.
export const DecideSharingRequestBody = registerSchema(
  "DecideSharingRequestBody",
  T.Object(
    {
      note: T.Optional(T.String({ maxLength: 1000 })),
    },
    { additionalProperties: false },
  ),
);
export type DecideSharingRequestDto = Static<typeof DecideSharingRequestBody>;
