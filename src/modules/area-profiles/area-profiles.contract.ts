import { registerSchema, T, type Static } from "../../contract/typebox";

const Pct = T.Union([T.Number({ minimum: 0, maximum: 100 }), T.Null()]);

// One area's official figures for one year (client, 7 Oct 2026, point 4e).
export const SaveAreaProfileBody = registerSchema(
  "SaveAreaProfileBody",
  T.Object(
    {
      level: T.Union([
        T.Literal("KINGDOM"),
        T.Literal("REGION"),
        T.Literal("GOVERNORATE"),
        T.Literal("CENTRE"),
        T.Literal("VILLAGE"),
      ]),
      regionId: T.Optional(T.Union([T.String({ format: "uuid" }), T.Null()])),
      governorateId: T.Optional(T.Union([T.String({ format: "uuid" }), T.Null()])),
      centerId: T.Optional(T.Union([T.String({ format: "uuid" }), T.Null()])),
      villageName: T.Optional(T.Union([T.String({ minLength: 1, maxLength: 150 }), T.Null()])),
      year: T.Integer({ minimum: 1990, maximum: 2100 }),
      population: T.Union([T.Integer({ minimum: 0 }), T.Null()]),
      growthRatePct: T.Union([T.Number({ minimum: -100, maximum: 100 }), T.Null()]),
      densityPerKm2: T.Union([T.Number({ minimum: 0 }), T.Null()]),
      malePct: Pct,
      femalePct: Pct,
      saudiPct: Pct,
      ruralPct: Pct,
      source: T.String({ minLength: 1, maxLength: 200 }),
    },
    { additionalProperties: false },
  ),
);
export type SaveAreaProfileDto = Static<typeof SaveAreaProfileBody>;
