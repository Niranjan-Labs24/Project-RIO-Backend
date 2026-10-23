import { describe, expect, it } from "vitest";
import { studyLocations } from "./citizen.service";

const tx = (study: unknown, needs: unknown[] = []) =>
  ({
    study: { findUnique: async () => study },
    need: { findMany: async () => needs },
  }) as never;

const gov = (id: string, name: string) => ({ governorate: { id, name, nameAr: `${name}-ar` } });
const centre = (id: string, name: string, governorateId: string) => ({ center: { id, name, nameAr: null, governorateId } });

describe("public survey location options", () => {
  it("lists villages with their governorate, plus a governorate that has no village listed", async () => {
    const r = await studyLocations(
      tx(
        { villages: ["Al-Jafr"], studyGovernorates: [gov("g1", "Al-Ahsa"), gov("g2", "Al-Qatif")], studyCenters: [] },
        [{ village: ["Al-Jafr"], needGovernorates: [{ governorateId: "g1" }], needCenters: [] }],
      ),
      "s1",
    );
    expect(r.level).toBe("MIXED");
    expect(r.options.map((o) => o.label)).toEqual(["Al-Jafr — Al-Ahsa", "Al-Qatif"]);
    expect(r.options[1]!.village).toEqual([]);
  });

  it("lists centres when the study names no villages, and only the governorates without one", async () => {
    const r = await studyLocations(
      tx({ villages: [], studyGovernorates: [gov("g1", "Al-Ahsa"), gov("g2", "Al-Qatif")], studyCenters: [centre("c1", "Al-Hofuf", "g1")] }),
      "s1",
    );
    expect(r.options.map((o) => o.value)).toEqual(["centre:c1", "gov:g2"]);
  });

  it("lists every centre of a governorate, and villages recorded on the Needs only", async () => {
    const r = await studyLocations(
      tx(
        {
          villages: [],
          studyGovernorates: [gov("g1", "Al-Ahsa"), gov("g2", "Al-Kharj")],
          studyCenters: [centre("c1", "Al-Hafayir", "g1"), centre("c2", "Al-Ghuwaybah", "g1"), centre("c3", "Al-Aziziyah", "g2"), centre("c4", "Al-Barrah", "g2")],
        },
        [{ village: ["Al-Jafr"], needGovernorates: [{ governorateId: "g1" }], needCenters: [{ centerId: "c1" }] }],
      ),
      "s1",
    );
    expect(r.options.map((o) => o.label)).toEqual(["Al-Jafr — Al-Ahsa", "Al-Ghuwaybah — Al-Ahsa", "Al-Aziziyah — Al-Kharj", "Al-Barrah — Al-Kharj"]);
  });

  it("keeps a village name used in two governorates apart, and merges capitals/spacing variants", async () => {
    const r = await studyLocations(
      tx(
        { villages: [], studyGovernorates: [gov("g1", "Al-Ahsa"), gov("g2", "Qatif")], studyCenters: [] },
        [
          { village: ["Al-Jafr", "AL-JAFR "], needGovernorates: [{ governorateId: "g1" }], needCenters: [] },
          { village: ["Al-Jafr"], needGovernorates: [{ governorateId: "g2" }], needCenters: [] },
        ],
      ),
      "s1",
    );
    expect(r.options.map((o) => o.label)).toEqual(["Al-Jafr — Al-Ahsa", "Al-Jafr — Qatif"]);
    expect(new Set(r.options.map((o) => o.value)).size).toBe(2);
    expect(r.options.map((o) => o.governorateIds)).toEqual([["g1"], ["g2"]]);
  });

  it("uses one level when everything is covered", async () => {
    const r = await studyLocations(tx({ villages: [], studyGovernorates: [gov("g1", "Al-Ahsa")], studyCenters: [] }), "s1");
    expect(r.level).toBe("GOVERNORATE");
  });
});
