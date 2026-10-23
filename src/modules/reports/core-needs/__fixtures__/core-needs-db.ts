import type { Prisma } from "../../../../generated/prisma";

// An in-memory stand-in for the tables the Core Needs Report reads: one study
// in two governorates of one region. Each model answers with fixed rows;
// `findUnique` looks rows up by id. Shared by the loader and NCNP tests.

const region = { id: "r1", code: 4, name: "Eastern Province", nameAr: "المنطقة الشرقية" };
const otherRegion = { id: "r2", code: 1, name: "Riyadh", nameAr: "الرياض" };
const gov1 = { id: "g1", code: "AHS", name: "Al-Ahsa", nameAr: "الأحساء", regionId: "r1", region };
const gov2 = { id: "g2", code: "QTF", name: "Qatif", nameAr: "القطيف", regionId: "r1", region };
const centre = { id: "c1", code: "C-1", name: "Hofuf", nameAr: "الهفوف", governorateId: "g1", governorate: gov1 };

export const needs = [
  // "Al-Jafr" in two governorates is two villages.
  { id: "n1", studyId: "s1", village: ["Al-Jafr", "Al-Qarain"], source: "field_survey", needGovernorates: [{ governorate: gov1 }], needCenters: [{ center: centre }] },
  { id: "n2", studyId: "s1", village: ["al-jafr "], source: "citizen_input", needGovernorates: [{ governorate: gov2 }], needCenters: [] },
  { id: "n3", studyId: "s1", village: [], source: "manual_entry", needGovernorates: [{ governorate: gov2 }], needCenters: [] },
];

const score = (id: string, need: string, picked: string[], gov: string[], question = "q1", severity: number | null = 80) => ({
  surveyId: "sv1",
  surveyResponseId: id,
  // The scoring engine stores the need's first village for every response.
  villageId: needs.find((n) => n.id === need)!.village[0] ?? null,
  questionId: question,
  scoreStatus: severity === null ? "EXCLUDED" : "SCORED",
  exclusionReason: severity === null ? "DONT_KNOW" : null,
  severityScore: severity,
  responseAnswer: { answerNumericValue: question === "q3" ? 6 : null },
  surveyResponse: { needId: need, governorateIds: gov, village: picked },
});
const scores = [
  score("a1", "n1", ["Al-Qarain"], ["g1"]), // picked village wins over the stored first village
  score("a2", "n1", [], ["g1"], "q2", null),
  score("a3", "n2", ["Al-Jafr"], ["g2"]), // same name, the respondent's governorate decides
  score("a4", "n1", ["Al-Jafr"], ["g1"], "q3", 20),
  score("a5", "n3", [], ["g2"], "q4", 50), // a question outside the nine-domain index
];

const responses = ["a1", "a2", "a3", "a4", "a5"].map((id, i) => ({
  id,
  needId: scores[i]!.surveyResponse.needId,
  governorateIds: scores[i]!.surveyResponse.governorateIds,
  village: scores[i]!.surveyResponse.village,
  gender: i % 2 ? "FEMALE" : "MALE",
  ageBracket: "25-44",
  submittedAt: new Date(Date.UTC(2026, 9, 1 + i)),
  qualityResults: i === 0 ? [{ isDuplicate: false, confidenceFlag: "LOW", completenessScore: 80 }] : [],
}));

export function fakeTx(over: { published?: unknown; surveys?: unknown[] } = {}): Prisma.TransactionClient {
  const byId = <T extends { id: string }>(rows: T[]) => ({ where }: { where: { id: string } }) => Promise.resolve(rows.find((r) => r.id === where.id) ?? null);
  const list = (rows: unknown[]) => () => Promise.resolve(rows);
  const tables = {
    study: {
      findUnique: byId([
        { id: "s1", title: "Community Needs", orgId: "o1", org: { name: "Sample Charity" }, population: 3000, requiredSampleSize: 30, marginOfError: 0.1, minimumDetectableEffect: 12, methodologyVersionId: "mv1", studyGovernorates: [{ governorate: gov1 }] },
      ]),
      findMany: list([{ id: "s1", methodologyVersionId: "mv1" }]),
    },
    survey: {
      findUnique: byId([{ id: "sv1", needId: "n1", targetGroup: "Households", selectionApproach: "Random", methodologyVersion: "v5.0" }]),
      findMany: list([{ id: "sv1", targetGroup: " Households ", need: { gapType: "structural" } }]),
      findFirst: ({ where }: { where: { status?: string } }) => {
        const rows = (over.surveys ?? [{ id: "sv-draft", status: "DRAFT" }, { id: "sv1", status: "PUBLISHED" }]) as Array<{ id: string; status: string }>;
        return Promise.resolve(rows.find((s) => !where.status || s.status === where.status) ?? null);
      },
    },
    methodologyVersion: { findUnique: byId([{ id: "mv1", version: "v5.0" }]), findFirst: list([]) },
    need: { findMany: list(needs) },
    region: { findUnique: byId([region]), findMany: list([region, otherRegion]) },
    governorate: { findUnique: byId([gov1, gov2]), count: () => Promise.resolve(10), findMany: list([{ code: "AHS", name: "Al-Ahsa" }]) },
    center: {
      findUnique: byId([centre]),
      findMany: list([{ code: "C-1", name: "Hofuf" }]),
      groupBy: list([{ governorateId: "g1", _count: { _all: 4 } }]),
    },
    scoreRollup: { findMany: list([{ surveyId: "sv1" }]) },
    responseSeverityScore: { findMany: list(scores) },
    surveyResponse: { count: () => Promise.resolve(2), findMany: list(responses) },
    question: {
      findMany: ({ where }: { where?: { excludedFromNineDomainIndex?: boolean } } = {}) =>
        Promise.resolve(
          where?.excludedFromNineDomainIndex === true
            ? [{ domain: "Facts" }]
            : [
                { questionId: "q1", domain: "Health", subDomain: "Access", indicator: "Distance", kpi: "HLT-01 — Far from a clinic", answerType: "single_choice", measurementMode: "categorical", analyticalCategory: "Access", rosterScope: null, answerOptions: ["Yes", "No"], excludedFromNineDomainIndex: false },
                { questionId: "q2", domain: "Health", subDomain: "Quality", indicator: "Waiting", kpi: "HLT-02 — Long waits", answerType: "single_choice", measurementMode: "categorical", analyticalCategory: null, rosterScope: "child", answerOptions: ["Often", "Never"], excludedFromNineDomainIndex: false },
                { questionId: "q3", domain: "Water", subDomain: "Supply", indicator: "Hours", kpi: "WAT-01 — Hours of supply", answerType: "numeric", measurementMode: "numeric", analyticalCategory: "Availability", rosterScope: "person", answerOptions: null, excludedFromNineDomainIndex: false },
                { questionId: "q4", domain: "Facts", subDomain: "General", indicator: null, kpi: null, answerType: "numeric", measurementMode: "numeric", analyticalCategory: null, rosterScope: null, answerOptions: null, excludedFromNineDomainIndex: true },
              ],
        ),
    },
    scoringLookup: { findMany: list([{ questionId: "q1", optionId: "yes", severityScore: 100, isExcluded: false }, { questionId: "q1", optionId: "dk", severityScore: null, isExcluded: true }]) },
    areaProfile: {
      findMany: list([
        { unitKey: "GOVERNORATE:g1", population: 1_200_000, growthRatePct: 2.1, densityPerKm2: 9, malePct: 51, femalePct: 49, saudiPct: 80, ruralPct: 20, source: "GASTAT", year: 2022 },
        { unitKey: "GOVERNORATE:g1", population: 1_000_000, growthRatePct: null, densityPerKm2: null, malePct: null, femalePct: null, saudiPct: null, ruralPct: null, source: "GASTAT", year: 2010 },
      ]),
    },
    domainPriorityConfig: { findMany: list([{ domainKey: "HEALTH", domainNameSnapshot: "Health", weight: "0.6", isCriticalDomain: true, criticalPerformanceThreshold: "40" }]) },
    needInitiative: {
      findMany: list([
        { initiative: { orgId: "o1", org: { name: "Sample Charity" } } },
        { initiative: { orgId: "o2", org: { name: "Another Charity" } } },
      ]),
    },
    methodologyConfigHistory: {
      findFirst: () =>
        Promise.resolve(
          "published" in over
            ? over.published
            : {
                confidenceFlagSettings: { minRespondentsForStandardConfidence: 12, dontKnowRatioThreshold: 0.25, villageConcentrationPct: 60, geographicCoverageMinPct: "", indicatorLinkPairs: [["HLT-01", "WAT-01"], ["bad"], [" ", "x"]] },
                priorityThresholds: { criticalSeverity: 85, highSeverity: "x" },
                priorityFactorScales: { equitySpreadThreshold: 30 },
              },
        ),
    },
    domain: { findMany: list([{ name: "Health", nameAr: "الصحة" }]) },
    subDomain: { findMany: list([{ name: "Access", nameAr: "الوصول" }]) },
  };
  return tables as unknown as Prisma.TransactionClient;
}

