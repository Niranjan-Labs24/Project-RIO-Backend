import { describe, expect, it } from "vitest";
import { loadCoreNeedsInputs, resolveStudySurveyId } from "./load-core-needs";
import { loadCoreScopeOptions, loadOrgCoreScopeOptions } from "./load-core-scope-options";
import { fakeTx } from "./__fixtures__/core-needs-db";

// The database reads, against the in-memory tables in __fixtures__.

const load = (scopeLevel: "KINGDOM" | "REGION" | "GOVERNORATE" | "CENTRE" | "VILLAGE", unitId: string | null, tx = fakeTx()) =>
  loadCoreNeedsInputs(tx, { studyId: "s1", surveyId: "sv1", scopeLevel, unitId });

describe("loadCoreNeedsInputs", () => {
  it("keeps one village name in two governorates apart, and places each answer in the village picked", async () => {
    const i = await load("KINGDOM", null);
    // Each keeps its first spelling as typed ("al-jafr " on the Qatif need).
    expect(i.villages.map((v) => v.name).sort()).toEqual(["Al-Jafr — Al-Ahsa", "Al-Qarain", "al-jafr — Qatif"]);
    const placed = new Map(i.answers.map((a) => [a.responseId, a.village]));
    expect(placed.get("a1")).toBe("Al-Qarain");
    expect(placed.get("a3")).toBe("al-jafr — Qatif");
    expect(placed.get("a4")).toBe("Al-Jafr — Al-Ahsa");
    // Kingdom scope lists every region, and counts the KSA governorates.
    expect(i.allRegions.map((r) => r.name)).toEqual(["Eastern Province", "Riyadh"]);
    expect(i.governoratesInUnitTotal).toBe(10);
  });

  it("reads the published methodology settings, ignoring unusable values", async () => {
    const i = await load("KINGDOM", null);
    expect(i.confidence).toEqual({ minRespondents: 12, dontKnowRatio: 0.25 });
    expect(i.tiers).toEqual({ critical: 85, high: 70, equityHigh: 50, medium: 40 });
    expect(i.equitySpreadThreshold).toBe(30);
    expect(i.concentratedFromPct).toBe(60);
    expect(i.coverageMinPct).toBeNull();
    expect(i.linkPairs).toEqual([["HLT-01", "WAT-01"]]);
  });

  it("falls back to the v5.0 defaults when nothing is published", async () => {
    const i = await load("KINGDOM", null, fakeTx({ published: null }));
    expect(i.confidence).toEqual({ minRespondents: 10, dontKnowRatio: 0.2 });
    expect(i.tiers.critical).toBe(80);
    expect(i.linkPairs).toEqual([]);
  });

  it("leaves the cross-domain facts out and reads each question's unit and options", async () => {
    const i = await load("KINGDOM", null);
    expect([...i.questions.keys()]).toEqual(["q1", "q2", "q3"]);
    expect(i.allDomains.map((d) => d.key)).toEqual(["HEALTH", "WATER"]);
    expect(i.questions.get("q1")).toMatchObject({ accessDimension: true, hasNo: true, unit: "HOUSEHOLDS", numeric: false });
    expect(i.questions.get("q2")).toMatchObject({ unit: "CHILDREN", hasNo: false });
    expect(i.questions.get("q3")).toMatchObject({ numeric: true, unit: "MEMBERS", accessDimension: true });
    expect(i.kpiSignature.get("HLT-01 — Far from a clinic")).toBe("q1[dk=x,yes=100]");
  });

  it("reads responses, profiles (latest year), other organisations and the collection period", async () => {
    const i = await load("KINGDOM", null);
    expect(i.responses.find((r) => r.id === "a1")).toMatchObject({ lowConfidence: true, incomplete: true, duplicate: false, villages: ["Al-Qarain"] });
    expect(i.profiles.get("GOVERNORATE:g1")?.year).toBe(2022);
    expect(i.otherOrganisations).toEqual(["Another Charity"]);
    expect(i.outsideGeography).toBe(2);
    expect(i.collectedFrom?.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(i.targetGroupBySurvey.get("sv1")).toBe("Households");
    expect(i.domainConfigs[0]).toMatchObject({ weight: 0.6, criticalPerformanceThreshold: 40 });
    expect(new Set(i.needSources)).toEqual(new Set(["field_survey", "citizen_input", "manual_entry"]));
  });

  it("narrows to a region, a governorate, a centre and a village", async () => {
    const r = await load("REGION", "r1");
    expect(r.unit).toMatchObject({ name: "Eastern Province", regionId: "r1" });
    expect(r.mapContext).toEqual([{ code: "AHS", name: "Al-Ahsa" }]);

    const g = await load("GOVERNORATE", "g2");
    expect(g.unit).toMatchObject({ name: "Qatif", parents: ["Eastern Province"] });
    expect(g.villages.map((v) => v.name)).toEqual(["al-jafr — Qatif"]);
    expect(g.answers.every((a) => a.governorateId === "g2")).toBe(true);

    const c = await load("CENTRE", "c1");
    expect(c.unit.parents).toEqual(["Al-Ahsa", "Eastern Province"]);
    expect(c.villages.every((v) => v.centerId === "c1")).toBe(true);

    const v = await load("VILLAGE", "Al-Jafr — Qatif");
    // Asked for in any capitals, as the scope options label it.
    expect(v.unit).toMatchObject({ name: "al-jafr — Qatif", parents: ["Qatif", "Eastern Province"] });
    expect(v.answers.map((a) => a.responseId)).toEqual(["a3"]);
    // A name used once in the study is found without its governorate.
    expect((await load("VILLAGE", "al-qarain")).unit.name).toBe("Al-Qarain");
  });

  it("fails clearly when the study or survey does not exist", async () => {
    await expect(loadCoreNeedsInputs(fakeTx(), { studyId: "nope", surveyId: "sv1", scopeLevel: "KINGDOM", unitId: null })).rejects.toThrow("no-data");
    await expect(loadCoreNeedsInputs(fakeTx(), { studyId: "s1", surveyId: "nope", scopeLevel: "KINGDOM", unitId: null })).rejects.toThrow("no-data");
  });
});

describe("resolveStudySurveyId", () => {
  it("prefers the published survey, else the newest", async () => {
    expect(await resolveStudySurveyId(fakeTx(), "s1")).toBe("sv1");
    expect(await resolveStudySurveyId(fakeTx({ surveys: [{ id: "sv-draft", status: "DRAFT" }] }), "s1")).toBe("sv-draft");
    expect(await resolveStudySurveyId(fakeTx({ surveys: [] }), "s1")).toBeNull();
  });
});

describe("loadCoreScopeOptions", () => {
  it("lists each area the studies cover once, villages by governorate and name", async () => {
    const o = await loadCoreScopeOptions(fakeTx(), "s1");
    expect(o.regions.map((r) => r.name)).toEqual(["Eastern Province"]);
    expect(o.governorates.map((g) => g.name)).toEqual(["Al-Ahsa", "Qatif"]);
    expect(o.centres.map((c) => c.name)).toEqual(["Hofuf"]);
    expect(o.villages.map((v) => v.name)).toEqual(["Al-Jafr — Al-Ahsa", "al-jafr — Qatif", "Al-Qarain"]);
    expect(o.domains).toEqual([
      { key: "HEALTH", name: "Health", nameAr: "الصحة" },
      { key: "WATER", name: "Water", nameAr: null },
    ]);
    expect(o.studyIds).toEqual(["s1"]);
  });

  it("covers every live study of the organisation", async () => {
    const o = await loadOrgCoreScopeOptions(fakeTx(), "o1");
    expect(o.studyIds).toEqual(["s1"]);
  });
});
