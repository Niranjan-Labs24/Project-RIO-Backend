// Core Needs Report — the database reads, in one place and one transaction.
//
// Everything here is a plain read of rows that already exist; the arithmetic
// lives in compute-unit-rollups.ts and build-core-needs.ts so it can be tested
// without a database.

import type { Prisma } from "../../../generated/prisma";
import type { AreaFigures, ScopeLevel } from "./core-needs.types";
import type { QuestionMeta, RespondentUnit, UnitAnswer } from "./compute-unit-rollups";
import { normalizeDomainKey } from "../../priority/priority-v2.service";

type Tx = Prisma.TransactionClient;

export interface VillageGeo {
  /** What the report shows: the first spelling entered, with its governorate
   *  added when another governorate has a village of the same name. */
  name: string;
  /** The first spelling entered on a need, as typed (area profile key). */
  typedName: string;
  /** Governorate plus the name without case or extra spaces (villageKey). */
  key: string;
  governorateId: string | null;
  governorateName: string | null;
  governorateCode: string | null;
  centerId: string | null;
  centerName: string | null;
  centerCode: string | null;
  regionId: string | null;
  regionName: string | null;
  regionCode: string | null;
}

/** A scored answer with the place it belongs to: its own village when the
 *  need names one, otherwise the need's governorate/centre. */
export interface GeoAnswer extends UnitAnswer {
  surveyId: string;
  village: string | null;
  governorateId: string | null;
  centerId: string | null;
  regionId: string | null;
  /** Names for the "where" column when the answer has no village. */
  governorateName?: string | null;
  centerName?: string | null;
  centerCode?: string | null;
}

/** Who a KPI's figure counts, from the v5.0 roster scope (Jagan, 19 Oct
 *  2026): households by default; person-level rosters name their people.
 *  The wording itself is in the label catalogue, for approval. */
function unitOfRoster(scope: string | null): RespondentUnit {
  switch ((scope ?? "").trim().toLowerCase()) {
    case "child":
      return "CHILDREN";
    case "youth":
      return "YOUTH";
    case "woman":
      return "WOMEN";
    case "person":
      return "MEMBERS";
    default:
      return "HOUSEHOLDS";
  }
}

export interface CoreResponse {
  id: string;
  villages: string[];
  gender: string | null;
  ageBracket: string | null;
  duplicate: boolean;
  lowConfidence: boolean;
  incomplete: boolean;
}

export interface CoreInputs {
  study: {
    id: string;
    title: string;
    orgId: string;
    organizationName: string | null;
    population: number | null;
    requiredSampleSize: number | null;
    marginOfError: number | null;
    minimumDetectableEffect: number | null;
    methodologyVersionId: string;
    methodologyVersionLabel: string;
  };
  survey: { id: string; needId: string; targetGroup: string | null; selectionApproach: string | null };
  /** Every survey of the study with scores under this methodology version. */
  surveyIds: string[];
  unit: {
    level: ScopeLevel;
    id: string | null;
    name: string | null;
    parents: string[];
    regionId: string | null;
  };
  /** Villages named on the study's needs inside the unit, with their geography. */
  villages: VillageGeo[];
  /** The study's governorates inside the unit (StudyGovernorate + needs). */
  governorates: Array<{ id: string; code: string; name: string; regionId: string; regionName: string; regionCode: string }>;
  /** Every unit at the map level inside the scope, for the needs map. */
  mapContext: Array<{ code: string; name: string }>;
  /** Governorates in the unit per the KSA reference (region scope only). */
  governoratesInUnitTotal: number | null;
  /** Every region in the KSA reference (Kingdom scope only, else empty): at
   *  Kingdom level the breakdown and coverage count all regions, so a study
   *  in one region reads as 1 of 13, not 1 of 1. */
  allRegions: Array<{ id: string; code: string; name: string }>;
  /** Every scored answer inside the unit, placed geographically. */
  answers: GeoAnswer[];
  /** Analyst-entered gap type of each survey's need. */
  gapTypeBySurvey: Map<string, string | null>;
  questions: Map<string, QuestionMeta>;
  /** Per KPI: its question codes with their answer options and severities in
   *  this methodology version — two versions combine a KPI only when these
   *  are identical (NCNP report, client 15 Oct 2026). */
  kpiSignature: Map<string, string>;
  /** KPIs shown separately per methodology version in a combined report. */
  methodologySplit: Array<{ kpi: string; versions: string[] }>;
  responses: CoreResponse[];
  needSources: string[];
  collectedFrom: Date | null;
  collectedTo: Date | null;
  /** Latest entered figures per unit key (see AreaProfile.unitKey). */
  profiles: Map<string, AreaFigures>;
  domainConfigs: Array<{
    domainKey: string;
    domainNameSnapshot: string;
    weight: number;
    isCriticalDomain: boolean;
    criticalPerformanceThreshold: number;
  }>;
  allDomains: Array<{ key: string; name: string }>;
  otherOrganisations: string[];
  /** v5.0 confidence rule, from the published methodology configuration. */
  confidence: { minRespondents: number; dontKnowRatio: number };
  /** v5.0 priority tiers, from the published methodology configuration. */
  tiers: { critical: number; high: number; equityHigh: number; medium: number };
  /** Equity flag (v5.0): a KPI whose results differ by at least this many
   *  points between gender or age groups (>= 5 each) is High from equityHigh. */
  equitySpreadThreshold: number;
  /** Settings v5.0 does not define — null / empty until a value is approved
   *  through methodology change control (client, 15 Oct 2026). */
  concentratedFromPct: number | null;
  coverageMinPct: number | null;
  governorateMinCentresPct: number | null;
  linkPairs: Array<[string, string]>;
  /** Each survey's target group, for KPIs in a report that combines surveys. */
  targetGroupBySurvey: Map<string, string | null>;
  /** Centres in each governorate per the KSA geographic reference — the
   *  interim coverage unit until village master data is available. */
  centresByGovernorate: Map<string, number>;
  /** Responses kept but excluded because the respondent chose "Outside these
   *  areas" at registration (client, 19 Oct 2026) — counted for the whole
   *  study, since they belong to no unit in it. */
  outsideGeography: number;
}

export interface CoreQuery {
  studyId: string;
  surveyId: string;
  scopeLevel: ScopeLevel;
  unitId: string | null;
}

export function villageUnitKey(governorateId: string | null, name: string): string {
  return `VILLAGE:${governorateId ?? ""}:${name.trim().toLowerCase()}`;
}

/** A typed village name compared without case or extra spaces. */
export function villageNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Villages are typed free text with no master list (client, 15 Oct 2026), so
 * one village is its governorate plus its name, ignoring case and spacing:
 * "Al Noor" and "al  noor" in one governorate are the same village, and an
 * "Al Noor" in two governorates is two villages. The names stay stored as
 * typed, so spelling variants can still be mapped once village master data
 * arrives.
 */
export function villageKey(governorateId: string | null, name: string): string {
  return `${governorateId ?? ""}\u0000${villageNameKey(name)}`;
}

/** Display labels by villageKey: the first spelling entered, with its
 *  governorate added ("Al Noor — Al-Ahsa") when the same name is used in
 *  another governorate, as the survey's location field does. */
export function villageLabels(
  villages: Array<{ key: string; typedName: string; governorateName: string | null }>,
): Map<string, string> {
  const keysByName = new Map<string, Set<string>>();
  for (const v of villages) {
    const name = villageNameKey(v.typedName);
    keysByName.set(name, (keysByName.get(name) ?? new Set()).add(v.key));
  }
  return new Map(
    villages.map((v) => [
      v.key,
      keysByName.get(villageNameKey(v.typedName))!.size > 1 && v.governorateName
        ? `${v.typedName} — ${v.governorateName}`
        : v.typedName,
    ]),
  );
}

/** Whether a requested village scope (a label from the scope options) is this
 *  village: by its label, or by "name — governorate" when the options
 *  covered several studies and this study has the name only once. */
export function isRequestedVillage(v: VillageGeo, requested: string): boolean {
  const wanted = villageNameKey(requested);
  return (
    villageNameKey(v.name) === wanted ||
    (!!v.governorateName && villageNameKey(`${v.typedName} — ${v.governorateName}`) === wanted)
  );
}

const num = (d: Prisma.Decimal | null | undefined): number | null => (d == null ? null : Number(d));

export async function loadCoreNeedsInputs(tx: Tx, q: CoreQuery): Promise<CoreInputs> {
  const study = await tx.study.findUnique({
    where: { id: q.studyId },
    include: {
      org: { select: { name: true } },
      studyGovernorates: { include: { governorate: { include: { region: true } } } },
    },
  });
  if (!study) throw new Error("no-data");

  const survey = await tx.survey.findUnique({ where: { id: q.surveyId } });
  if (!survey) throw new Error("no-data");

  const mv =
    (study.methodologyVersionId
      ? await tx.methodologyVersion.findUnique({ where: { id: study.methodologyVersionId } })
      : null) ??
    (await tx.methodologyVersion.findFirst({
      where: survey.methodologyVersion ? { version: survey.methodologyVersion } : { status: "PUBLISHED" },
      orderBy: { createdAt: "desc" },
    }));
  if (!mv) throw new Error("no-data");

  // ── Needs and the geography of every village they name ──
  const needs = await tx.need.findMany({
    where: { studyId: q.studyId, mergedIntoNeedId: null },
    select: {
      id: true,
      village: true,
      source: true,
      needGovernorates: { select: { governorate: { include: { region: true } } } },
      needCenters: { select: { center: { select: { id: true, name: true, code: true, governorateId: true } } } },
    },
  });

  const geoByVillage = new Map<string, VillageGeo>(); // by villageKey
  const geoByNeed = new Map<string, Omit<VillageGeo, "name" | "typedName" | "key">>();
  for (const need of needs) {
    // A village inherits the first governorate its need names — same rule as
    // the Regional report, so a village is never counted under two.
    const gov = need.needGovernorates[0]?.governorate ?? null;
    const center = need.needCenters.find((c) => !gov || c.center.governorateId === gov.id)?.center ?? null;
    const geo = {
      governorateId: gov?.id ?? null,
      governorateName: gov?.name ?? null,
      governorateCode: gov?.code ?? null,
      centerId: center?.id ?? null,
      centerName: center?.name ?? null,
      centerCode: center?.code ?? null,
      regionId: gov?.regionId ?? null,
      regionName: gov?.region.name ?? null,
      // Region boundaries are keyed by ISO code (SA-01 …), not Region.code.
      regionCode: gov ? String(gov.region.code) : null,
    };
    geoByNeed.set(need.id, geo);
    for (const v of need.village) {
      const typedName = v.trim();
      const key = villageKey(geo.governorateId, typedName);
      if (!typedName || geoByVillage.has(key)) continue;
      geoByVillage.set(key, { name: typedName, typedName, key, ...geo });
    }
  }
  const labels = villageLabels([...geoByVillage.values()]);
  for (const v of geoByVillage.values()) v.name = labels.get(v.key) ?? v.typedName;
  // The village a typed name refers to: in the governorate the respondent
  // picked (public survey location), else that of the need it was entered
  // against, or the only village of that name in the study.
  const villageOf = (
    typed: string | null | undefined,
    needId: string | null | undefined,
    governorateId?: string | null,
  ): VillageGeo | undefined => {
    const name = typed?.trim();
    if (!name) return undefined;
    const own =
      (governorateId ? geoByVillage.get(villageKey(governorateId, name)) : undefined) ??
      geoByVillage.get(villageKey((needId && geoByNeed.get(needId)?.governorateId) || null, name));
    if (own) return own;
    const same = [...geoByVillage.values()].filter((v) => villageNameKey(v.typedName) === villageNameKey(name));
    return same.length === 1 ? same[0] : undefined;
  };

  // ── The selected unit ──
  const unit: CoreInputs["unit"] = { level: q.scopeLevel, id: q.unitId, name: null, parents: [], regionId: null };
  let governoratesInUnitTotal: number | null = null;
  let unitVillage: VillageGeo | null = null;
  if (q.scopeLevel === "REGION" && q.unitId) {
    const region = await tx.region.findUnique({ where: { id: q.unitId } });
    unit.name = region?.name ?? null;
    unit.regionId = q.unitId;
    governoratesInUnitTotal = await tx.governorate.count({ where: { regionId: q.unitId } });
  } else if (q.scopeLevel === "GOVERNORATE" && q.unitId) {
    const g = await tx.governorate.findUnique({ where: { id: q.unitId }, include: { region: true } });
    unit.name = g?.name ?? null;
    unit.parents = g ? [g.region.name] : [];
    unit.regionId = g?.regionId ?? null;
  } else if (q.scopeLevel === "CENTRE" && q.unitId) {
    const c = await tx.center.findUnique({
      where: { id: q.unitId },
      include: { governorate: { include: { region: true } } },
    });
    unit.name = c?.name ?? null;
    unit.parents = c ? [c.governorate.name, c.governorate.region.name] : [];
    unit.regionId = c?.governorate.regionId ?? null;
  } else if (q.scopeLevel === "VILLAGE" && q.unitId) {
    const all = [...geoByVillage.values()];
    const sameName = all.filter((v) => villageNameKey(v.typedName) === villageNameKey(q.unitId!));
    const geo = all.find((v) => isRequestedVillage(v, q.unitId!)) ?? (sameName.length === 1 ? sameName[0] : undefined);
    unitVillage = geo ?? null;
    unit.name = geo?.name ?? q.unitId.trim();
    unit.parents = [geo?.governorateName, geo?.regionName].filter((x): x is string => !!x);
    unit.regionId = geo?.regionId ?? null;
  } else if (q.scopeLevel === "KINGDOM") {
    governoratesInUnitTotal = await tx.governorate.count();
  }

  const inUnit = (g: { name?: string | null; regionId: string | null; governorateId: string | null; centerId: string | null }): boolean => {
    switch (q.scopeLevel) {
      case "KINGDOM":
        return true;
      case "REGION":
        return g.regionId === q.unitId;
      case "GOVERNORATE":
        return g.governorateId === q.unitId;
      case "CENTRE":
        return g.centerId === q.unitId;
      case "VILLAGE":
        return !!g.name && g.name === unitVillage?.name;
    }
  };
  const villages = [...geoByVillage.values()].filter(inUnit).sort((a, b) => a.name.localeCompare(b.name));
  const villageNames = new Set(villages.map((v) => v.name));

  // The study's governorates in the unit: its selected ones plus any a need names.
  const govMap = new Map<string, CoreInputs["governorates"][number]>();
  const addGov = (g: { id: string; code: string; name: string; regionId: string; region: { name: string; code: number } }) => {
    if (!govMap.has(g.id))
      govMap.set(g.id, { id: g.id, code: g.code, name: g.name, regionId: g.regionId, regionName: g.region.name, regionCode: String(g.region.code) });
  };
  for (const sg of study.studyGovernorates) addGov(sg.governorate);
  for (const n of needs) for (const ng of n.needGovernorates) addGov(ng.governorate);
  const governorates = [...govMap.values()]
    .filter((g) => {
      if (q.scopeLevel === "KINGDOM") return true;
      if (q.scopeLevel === "REGION") return g.regionId === q.unitId;
      if (q.scopeLevel === "GOVERNORATE") return g.id === q.unitId;
      return villages.some((v) => v.governorateId === g.id);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── Map context: every unit at the map level inside the scope ──
  let mapContext: Array<{ code: string; name: string }> = [];
  let allRegions: CoreInputs["allRegions"] = [];
  if (q.scopeLevel === "KINGDOM") {
    // The map's region shapes are keyed by the region's numeric code.
    allRegions = (await tx.region.findMany({ select: { id: true, code: true, name: true } }))
      .map((r) => ({ id: r.id, code: String(r.code), name: r.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    mapContext = allRegions.map((r) => ({ code: r.code, name: r.name }));
  } else if (q.scopeLevel === "REGION" && q.unitId) {
    mapContext = await tx.governorate.findMany({ where: { regionId: q.unitId }, select: { code: true, name: true } });
  } else if (q.scopeLevel === "GOVERNORATE" && q.unitId) {
    mapContext = await tx.center.findMany({ where: { governorateId: q.unitId }, select: { code: true, name: true } });
  }

  // ── Surveys, answers and the questions they answer ──
  const surveyIds = (
    await tx.scoreRollup.findMany({
      where: { studyId: q.studyId, methodologyVersionId: mv.id, rollupLevel: "OVERALL" },
      select: { surveyId: true },
      distinct: ["surveyId"],
    })
  ).map((r) => r.surveyId);
  if (!surveyIds.includes(q.surveyId)) surveyIds.push(q.surveyId);

  const scoreRows = await tx.responseSeverityScore.findMany({
    where: { studyId: q.studyId, surveyId: { in: surveyIds }, methodologyVersionId: mv.id },
    select: {
      surveyId: true,
      surveyResponseId: true,
      villageId: true,
      questionId: true,
      scoreStatus: true,
      exclusionReason: true,
      severityScore: true,
      responseAnswer: { select: { answerNumericValue: true } },
      surveyResponse: { select: { needId: true, governorateIds: true, village: true } },
    },
  });

  const answers: GeoAnswer[] = [];
  for (const r of scoreRows) {
    // The village the respondent picked (public survey location, 19 Oct 2026)
    // wins: the stored score carries the Need's first village for every
    // response (scoring engine), so several villages on one Need would all be
    // counted as the first.
    const picked = r.surveyResponse.village.find((v) => v.trim()) ?? r.villageId;
    const own = villageOf(picked, r.surveyResponse.needId, r.surveyResponse.governorateIds[0]);
    const village = own?.name ?? (picked?.trim() || null);
    const geo = own ?? geoByNeed.get(r.surveyResponse.needId);
    const placed = {
      name: village,
      regionId: geo?.regionId ?? null,
      governorateId: geo?.governorateId ?? null,
      centerId: geo?.centerId ?? null,
    };
    if (!inUnit(placed)) continue;
    answers.push({
      surveyId: r.surveyId,
      responseId: r.surveyResponseId,
      questionId: r.questionId,
      status: r.scoreStatus,
      exclusionReason: r.exclusionReason,
      severity: num(r.severityScore),
      numericValue: num(r.responseAnswer?.answerNumericValue),
      village,
      governorateId: placed.governorateId,
      centerId: placed.centerId,
      regionId: placed.regionId,
      governorateName: geo?.governorateName ?? null,
      centerName: geo?.centerName ?? null,
      centerCode: geo?.centerCode ?? null,
    });
  }

  const surveyNeeds = await tx.survey.findMany({
    where: { id: { in: surveyIds } },
    select: { id: true, targetGroup: true, need: { select: { gapType: true } } },
  });
  const gapTypeBySurvey = new Map(surveyNeeds.map((sv) => [sv.id, sv.need.gapType ?? null]));
  const targetGroupBySurvey = new Map(surveyNeeds.map((sv) => [sv.id, sv.targetGroup?.trim() || null]));

  const centreCounts = governorates.length
    ? await tx.center.groupBy({ by: ["governorateId"], where: { governorateId: { in: governorates.map((g) => g.id) } }, _count: { _all: true } })
    : [];
  const centresByGovernorate = new Map(centreCounts.map((c) => [c.governorateId, c._count._all]));
  const outsideGeography = await tx.surveyResponse.count({
    where: { studyId: q.studyId, exclusionReason: "OUTSIDE_STUDY_GEOGRAPHY" },
  });

  const questionRows = await tx.question.findMany({
    // The cross-domain "facts" items sit outside the nine-domain index in the
    // methodology, so they are not a domain of this report either.
    where: { methodologyVersionId: mv.id, usedInMvp: true, excludedFromNineDomainIndex: false },
    select: { questionId: true, domain: true, subDomain: true, indicator: true, kpi: true, answerType: true, measurementMode: true, analyticalCategory: true, rosterScope: true, answerOptions: true },
  });
  // A domain any of whose items sit outside the nine-domain index (the
  // cross-domain "facts" group) is not a domain of this report.
  const outsideIndex = new Set(
    (
      await tx.question.findMany({
        where: { methodologyVersionId: mv.id, excludedFromNineDomainIndex: true },
        select: { domain: true },
        distinct: ["domain"],
      })
    ).map((r) => r.domain),
  );
  for (let i = questionRows.length - 1; i >= 0; i--) if (outsideIndex.has(questionRows[i]!.domain)) questionRows.splice(i, 1);
  const questions = new Map<string, QuestionMeta>();
  for (const row of questionRows) {
    questions.set(row.questionId, {
      questionId: row.questionId,
      domain: row.domain,
      subDomain: row.subDomain,
      indicator: row.indicator,
      kpi: row.kpi,
      numeric: /numeric/i.test(row.measurementMode) || /numeric/i.test(row.answerType),
      accessDimension: /^(access|availability)$/i.test((row.analyticalCategory ?? "").trim()),
      unit: unitOfRoster(row.rosterScope),
      hasNo: Array.isArray(row.answerOptions)
        ? (row.answerOptions as unknown[]).some((o) => typeof o === "string" && o.trim().toLowerCase() === "no")
        : false,
    });
  }

  const lookupRows = await tx.scoringLookup.findMany({
    where: { methodologyVersionId: mv.id, isActive: true, questionId: { in: [...questions.keys()] } },
    select: { questionId: true, optionId: true, severityScore: true, isExcluded: true },
  });
  const optionsByQuestion = new Map<string, string[]>();
  for (const l of lookupRows) {
    const list = optionsByQuestion.get(l.questionId) ?? [];
    list.push(`${l.optionId}=${l.isExcluded ? "x" : String(l.severityScore ?? "")}`);
    optionsByQuestion.set(l.questionId, list);
  }
  const kpiSignature = new Map<string, string>();
  for (const q of questions.values()) {
    if (!q.kpi) continue;
    const codes = [...questions.values()].filter((x) => x.kpi === q.kpi).map((x) => x.questionId).sort();
    kpiSignature.set(q.kpi, codes.map((c) => `${c}[${(optionsByQuestion.get(c) ?? []).sort().join(",")}]`).join(";"));
  }

  // ── Responses: who answered, and why any were left out ──
  const responseIds = [...new Set(answers.map((a) => a.responseId))];
  const responseRows = responseIds.length
    ? await tx.surveyResponse.findMany({
        where: { id: { in: responseIds } },
        select: {
          id: true,
          needId: true,
          governorateIds: true,
          village: true,
          gender: true,
          ageBracket: true,
          submittedAt: true,
          qualityResults: { select: { isDuplicate: true, confidenceFlag: true, completenessScore: true } },
        },
      })
    : [];
  const responses: CoreResponse[] = responseRows.map((r) => {
    const quality = r.qualityResults[0];
    return {
      id: r.id,
      villages: [
        ...new Set(r.village.map((v) => villageOf(v, r.needId, r.governorateIds[0])?.name).filter((v): v is string => !!v && villageNames.has(v))),
      ],
      gender: r.gender ?? null,
      ageBracket: r.ageBracket ?? null,
      duplicate: quality?.isDuplicate ?? false,
      lowConfidence: quality ? String(quality.confidenceFlag).toUpperCase() === "LOW" : false,
      incomplete: quality ? quality.completenessScore < 100 : false,
    };
  });
  const submitted = responseRows.map((r) => r.submittedAt.getTime());

  // ── Area profiles: the unit, its governorates and its villages ──
  const unitKeys = new Set<string>();
  if (q.scopeLevel === "KINGDOM") unitKeys.add("KINGDOM");
  if (q.scopeLevel === "REGION" && q.unitId) unitKeys.add(`REGION:${q.unitId}`);
  if (q.scopeLevel === "GOVERNORATE" && q.unitId) unitKeys.add(`GOVERNORATE:${q.unitId}`);
  if (q.scopeLevel === "CENTRE" && q.unitId) unitKeys.add(`CENTRE:${q.unitId}`);
  for (const g of governorates) unitKeys.add(`GOVERNORATE:${g.id}`);
  // The breakdown's own rows: regions at Kingdom scope (every region, as the
  // table lists them all) and centres at governorate scope — their population
  // gives each row its "households of required" figure (client, 15 Oct 2026).
  for (const r of allRegions) unitKeys.add(`REGION:${r.id}`);
  for (const g of governorates) unitKeys.add(`REGION:${g.regionId}`);
  for (const n of needs) for (const { center } of n.needCenters) unitKeys.add(`CENTRE:${center.id}`);
  for (const v of villages) {
    unitKeys.add(villageUnitKey(v.governorateId, v.typedName));
    if (v.centerId) unitKeys.add(`CENTRE:${v.centerId}`);
  }
  const profileRows = await tx.areaProfile.findMany({
    where: { unitKey: { in: [...unitKeys] } },
    orderBy: { year: "desc" },
  });
  const profiles = new Map<string, AreaFigures>();
  for (const p of profileRows) {
    if (profiles.has(p.unitKey)) continue; // latest year first
    profiles.set(p.unitKey, {
      population: p.population,
      growthRatePct: num(p.growthRatePct),
      densityPerKm2: num(p.densityPerKm2),
      malePct: num(p.malePct),
      femalePct: num(p.femalePct),
      saudiPct: num(p.saudiPct),
      ruralPct: num(p.ruralPct),
      source: p.source,
      year: p.year,
    });
  }

  // ── Domain weights, and other organisations working on the same need ──
  const domainConfigs = (await tx.domainPriorityConfig.findMany({ where: { methodologyVersionId: mv.id } })).map(
    (c) => ({
      domainKey: c.domainKey,
      domainNameSnapshot: c.domainNameSnapshot,
      weight: Number(c.weight),
      isCriticalDomain: c.isCriticalDomain,
      criticalPerformanceThreshold: Number(c.criticalPerformanceThreshold),
    }),
  );

  const links = await tx.needInitiative.findMany({
    where: { needId: survey.needId },
    select: { initiative: { select: { orgId: true, org: { select: { name: true } } } } },
  });
  const otherOrganisations = [
    ...new Set(
      links
        .filter((l) => l.initiative.orgId !== study.orgId)
        .map((l) => l.initiative.org.name),
    ),
  ];

  // The PUBLISHED methodology configuration — never a pending edit — the same
  // source every scoring consumer reads (MethodologyConfigService.getRaw).
  const published = await tx.methodologyConfigHistory.findFirst({
    where: { changeType: "publish" },
    orderBy: { changedAt: "desc" },
    select: { confidenceFlagSettings: true, priorityThresholds: true, priorityFactorScales: true },
  });
  const settings = (published?.confidenceFlagSettings ?? {}) as {
    villageConcentrationPct?: unknown;
    minRespondentsForStandardConfidence?: unknown;
    dontKnowRatioThreshold?: unknown;
    geographicCoverageMinPct?: unknown;
    governorateMinCentresPct?: unknown;
    indicatorLinkPairs?: unknown;
  };
  const thresholds = (published?.priorityThresholds ?? {}) as Record<string, unknown>;
  const pctSetting = (v: unknown): number | null => {
    const x = Number(v);
    return v != null && v !== "" && Number.isFinite(x) && x > 0 && x <= 100 ? x : null;
  };
  const tier = (v: unknown, fallback: number): number => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : fallback;
  };
  const minRespondents = Number(settings.minRespondentsForStandardConfidence);
  const dkRatio = Number(settings.dontKnowRatioThreshold);
  const linkPairs = Array.isArray(settings.indicatorLinkPairs)
    ? settings.indicatorLinkPairs
        .filter((p): p is [string, string] => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "string" && x.trim()))
        .map(([a, b]) => [a.trim(), b.trim()] as [string, string])
    : [];

  return {
    study: {
      id: study.id,
      title: study.title,
      orgId: study.orgId,
      organizationName: study.org?.name ?? null,
      population: study.population,
      requiredSampleSize: study.requiredSampleSize,
      marginOfError: study.marginOfError,
      minimumDetectableEffect: study.minimumDetectableEffect,
      methodologyVersionId: mv.id,
      methodologyVersionLabel: mv.version,
    },
    survey: {
      id: survey.id,
      needId: survey.needId,
      targetGroup: survey.targetGroup,
      selectionApproach: survey.selectionApproach,
    },
    surveyIds,
    unit,
    villages,
    governorates,
    mapContext,
    governoratesInUnitTotal,
    allRegions,
    answers,
    gapTypeBySurvey,
    questions,
    kpiSignature,
    methodologySplit: [],
    responses,
    needSources: [
      ...new Set(
        needs
          .filter(
            (n) =>
              n.village.some((v) => villageNames.has(villageOf(v, n.id)?.name ?? "")) ||
              (n.village.length === 0 && inUnit({ name: null, ...(geoByNeed.get(n.id) ?? { regionId: null, governorateId: null, centerId: null }) })),
          )
          .map((n) => n.source),
      ),
    ],
    collectedFrom: submitted.length ? new Date(Math.min(...submitted)) : null,
    collectedTo: submitted.length ? new Date(Math.max(...submitted)) : null,
    profiles,
    domainConfigs,
    allDomains: [...new Set(questionRows.map((r) => r.domain))].map((name) => ({
      key: normalizeDomainKey(name),
      name,
    })),
    otherOrganisations,
    confidence: {
      minRespondents: Number.isFinite(minRespondents) && minRespondents > 0 ? minRespondents : 10,
      dontKnowRatio: Number.isFinite(dkRatio) && dkRatio > 0 ? dkRatio : 0.2,
    },
    tiers: {
      critical: tier(thresholds.criticalSeverity, 80),
      high: tier(thresholds.highSeverity, 70),
      equityHigh: tier(thresholds.equityHighSeverity, 50),
      medium: tier(thresholds.mediumSeverity, 40),
    },
    equitySpreadThreshold: tier(((published?.priorityFactorScales ?? {}) as Record<string, unknown>).equitySpreadThreshold, 50),
    concentratedFromPct: pctSetting(settings.villageConcentrationPct),
    coverageMinPct: pctSetting(settings.geographicCoverageMinPct),
    governorateMinCentresPct: pctSetting(settings.governorateMinCentresPct),
    linkPairs,
    targetGroupBySurvey,
    centresByGovernorate,
    outsideGeography,
  };
}

/** The survey a study's figures come from: the published one, else the newest
 *  (same rule as the study-scoped reports). Null when the study has none. */
export async function resolveStudySurveyId(tx: Tx, studyId: string): Promise<string | null> {
  const s =
    (await tx.survey.findFirst({ where: { studyId, status: "PUBLISHED" }, orderBy: { createdAt: "desc" } })) ??
    (await tx.survey.findFirst({ where: { studyId }, orderBy: { createdAt: "desc" } }));
  return s?.id ?? null;
}
