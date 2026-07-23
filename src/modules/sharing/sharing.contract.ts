import { registerSchema, T, type Static } from "../../contract/typebox";

export const CreateSharingRequestBody = registerSchema(
  "CreateSharingRequestBody",
  T.Object(
    {
      ownerOrgId: T.String({ format: "uuid" }),
      studyId: T.String({ format: "uuid" }),
      note: T.Optional(T.String({ maxLength: 1000 })),
    },
    { additionalProperties: false },
  ),
);
export type CreateSharingRequestDto = Static<typeof CreateSharingRequestBody>;

// Optional reason on approve/reject — see SharingRequest.decisionNote.
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
