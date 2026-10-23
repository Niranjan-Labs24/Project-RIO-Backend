// Core Needs Report (RPT18) — the pure composition step.
//
// Takes the rows load-core-needs.ts read and produces the stored content. No
// database, no wording: every figure here is a number, a code or a name, so a
// reader in either language gets the same report and the arithmetic can be
// tested in isolation.

import { calculateSampleSize } from '../../studies/sample-size';
import { computeVillagePriority, normalizeDomainKey } from '../../priority/priority-v2.service';
import type { GapType, SeverityBand } from '../need-record.types';
import {
  CORE_NEEDS_CONFIG,
  coreDecisionFor,
  type ConfidenceResult,
  type CoreNeedsConfig,
} from './core-needs.config';
import {
  computeUnitRollups,
  type ConfidenceSettings,
  type QuestionMeta,
  type UnitRollups,
} from './compute-unit-rollups';
import type {
  ActualValue,
  ConfidenceComponents,
  CoreDomainRow,
  CoreEvidence,
  CoreGeography,
  CoreHierarchyDomain,
  CoreLinks,
  CoreNeedCard,
  CoreNeedsContent,
  CoreOutput,
  CoreRankedNeed,
  CoreVillageRow,
  GeographyUnit,
  UnitKind,
} from './core-needs.types';
import { villageUnitKey, type CoreInputs, type GeoAnswer } from './load-core-needs';

const anyLow = (...rs: Array<ConfidenceResult | null>): ConfidenceResult =>
  rs.includes('LOW') ? 'LOW' : 'MEETS';
const round1 = (n: number): number => Math.round(n * 10) / 10;
const pct = (part: number, whole: number): number => (whole > 0 ? round1((part / whole) * 100) : 0);

export interface BuildCoreNeedsInput {
  inputs: CoreInputs;
  output: CoreOutput;
  /** Normalized domain keys the user selected; null = all. */
  domainKeys: string[] | null;
  filters: Record<string, unknown>;
  generatedAt: string;
  config?: CoreNeedsConfig;
}

/** Sample adequacy, the v5.0 rule (client, 15 Oct 2026): LOW below the
 *  methodology minimum of valid responses, or below the required sample. */
export function sampleResultOf(
  valid: number,
  required: number | null,
  minimum: number,
): ConfidenceResult {
  return valid < minimum || (required != null && valid < required) ? 'LOW' : 'MEETS';
}

/**
 * The v5.0 priority tiers, from the methodology configuration, applied the
 * same way at every level — KPI, sub-domain, domain, area and needs index
 * (client, 23 Oct 2026): Critical at or above the Critical threshold in any
 * domain (no Health / Water & Sanitation restriction), High at or above the
 * High threshold or the equity threshold with the equity flag, then Medium
 * and Low. A score reads the same tier everywhere in the product.
 */
export function tierOf(
  severity: number | null,
  tiers: { critical: number; high: number; medium: number; equityHigh?: number },
  criticalEligible = true,
  equityFlagged = false,
): SeverityBand | null {
  if (severity === null) return null;
  if (severity >= tiers.critical) return criticalEligible ? 'CRITICAL' : 'HIGH';
  if (severity >= tiers.high) return 'HIGH';
  // v5.0: High from the equity threshold when results differ materially
  // between gender or age groups (the equity flag).
  if (equityFlagged && tiers.equityHigh != null && severity >= tiers.equityHigh) return 'HIGH';
  if (severity >= tiers.medium) return 'MEDIUM';
  return 'LOW';
}

function requiredFor(
  population: number | null | undefined,
  marginOfError: number | null,
): number | null {
  if (!population || population <= 0 || !Number.isInteger(population)) return null;
  try {
    return calculateSampleSize(population, marginOfError ?? undefined).requiredSampleSize;
  } catch {
    return null;
  }
}

/** Households counted once: distinct responses with at least one scored answer. */
function households(answers: GeoAnswer[]): { valid: number; submitted: number } {
  const all = new Set<string>();
  const valid = new Set<string>();
  for (const a of answers) {
    all.add(a.responseId);
    if (a.status === 'SCORED' && a.severity !== null) valid.add(a.responseId);
  }
  return { valid: valid.size, submitted: all.size };
}

/** Deduplicated (response, question) answers — see compute-unit-rollups. */
function dedupe(answers: GeoAnswer[]): GeoAnswer[] {
  const seen = new Set<string>();
  return answers.filter((a) => {
    const k = `${a.responseId}\u0000${a.questionId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function buildCoreNeedsContent(input: BuildCoreNeedsInput): CoreNeedsContent {
  const cfg = input.config ?? CORE_NEEDS_CONFIG;
  const { inputs } = input;
  const study = inputs.study;
  const settings: ConfidenceSettings = {
    minRespondents: inputs.confidence.minRespondents,
    dontKnowRatio: inputs.confidence.dontKnowRatio,
    requiredSampleSize: study.requiredSampleSize,
  };

  // ── Domain selection ──
  const selectedDomains = inputs.allDomains.filter(
    (d) => !input.domainKeys || input.domainKeys.length === 0 || input.domainKeys.includes(d.key),
  );
  const selectedNames = new Set(selectedDomains.map((d) => d.name));
  const questions = new Map<string, QuestionMeta>(
    [...inputs.questions].filter(([, q]) => selectedNames.has(q.domain)),
  );
  const answers = inputs.answers.filter((a) => questions.has(a.questionId));
  const unitAnswers = dedupe(answers);
  const roll = computeUnitRollups(answers, questions, settings);

  const minimum = inputs.confidence.minRespondents;
  const dontKnowLimitPct = round1(inputs.confidence.dontKnowRatio * 100);
  const tiers = inputs.tiers;
  // Every KPI may be Critical (19 Oct 2026), as may every aggregate (23 Oct).
  const kpiCriticalEligible = (_kpi: string): boolean => true;

  // The equity flag per KPI, the v5.0 rule PriorityService applies per need:
  // the spread between the best- and worst-scoring gender or age group
  // (groups of at least 5 scored answers) reaching the configured threshold.
  const segmentsOf = new Map(inputs.responses.map((r) => [r.id, [r.gender, r.ageBracket]]));
  const kpiEquityFlagged = (kpi: string): boolean => {
    const qIds = new Set([...questions.values()].filter((q) => q.kpi === kpi).map((q) => q.questionId));
    const buckets = new Map<string, { sum: number; count: number }>();
    for (const a of unitAnswers) {
      if (!qIds.has(a.questionId) || a.status !== 'SCORED' || a.severity === null) continue;
      for (const seg of segmentsOf.get(a.responseId) ?? []) {
        if (!seg || seg === 'prefer_not_to_say') continue;
        const b = buckets.get(seg) ?? { sum: 0, count: 0 };
        b.sum += a.severity;
        b.count += 1;
        buckets.set(seg, b);
      }
    }
    const means = [...buckets.values()].filter((b) => b.count >= 5).map((b) => b.sum / b.count);
    return means.length >= 2 && Math.max(...means) - Math.min(...means) >= inputs.equitySpreadThreshold;
  };
  const aggregateTier = (score: number | null) => tierOf(score, tiers);

  const weightByKey = new Map(inputs.domainConfigs.map((c) => [c.domainKey, c.weight]));
  const kpiMeta = new Map<string, QuestionMeta>();
  for (const q of questions.values()) if (q.kpi && !kpiMeta.has(q.kpi)) kpiMeta.set(q.kpi, q);

  // ── Actual values (client, 15 Oct 2026) ──
  // Share whose need is not fully met (any answer scored above 0), with the
  // share at full severity — the "No" answer — in brackets. Scored answers
  // only, so "Don't know" is outside the base. Numeric questions: the median.
  const actualFor = (kpi: string, rows: GeoAnswer[]): ActualValue | null => {
    const qIds = new Set(
      [...questions.values()].filter((q) => q.kpi === kpi).map((q) => q.questionId),
    );
    const scored = dedupe(rows).filter(
      (a) => qIds.has(a.questionId) && a.status === 'SCORED' && a.severity !== null,
    );
    if (!scored.length) return null;
    const numeric = [...qIds].some((id) => questions.get(id)?.numeric);
    const values = scored.map((a) => a.numericValue).filter((v): v is number => v !== null);
    if (numeric && values.length)
      return { kind: 'MEDIAN', value: round1(median(values)), n: values.length };
    const notMet = scored.filter((a) => a.severity! > 0).length;
    const no = scored.filter((a) => a.severity! >= 100).length;
    return {
      kind: 'PCT',
      notMetPct: pct(notMet, scored.length),
      noPct: pct(no, scored.length),
      n: scored.length,
      unit: [...qIds].map((id) => questions.get(id)?.unit).find(Boolean) ?? 'HOUSEHOLDS',
      hasNo: [...qIds].some((id) => questions.get(id)?.hasNo),
    };
  };

  // ── Totals for the unit ──
  const hh = households(answers);
  const dk = unitAnswers.filter((a) => a.exclusionReason === 'DONT_KNOW').length;
  const scoredAnswers = unitAnswers.filter(
    (a) => a.status === 'SCORED' && a.severity !== null,
  ).length;
  const dontKnowPct = pct(dk, scoredAnswers + dk);
  const answersExcluded = unitAnswers.filter((a) => a.status === 'EXCLUDED').length;

  // ── Child units: the geography one level below the scope ──
  const level = inputs.unit.level;
  // Centres are the interim unit until village master data exists (client,
  // 15 Oct 2026): a governorate breaks down by centre whether its villages
  // name one or the answers were placed at a centre directly.
  const hasCentres =
    inputs.villages.some((v) => v.centerId) || inputs.answers.some((a) => a.centerId && a.centerName);
  const childKind: UnitKind | null =
    level === 'KINGDOM'
      ? 'REGION'
      : level === 'REGION'
        ? 'GOVERNORATE'
        : level === 'GOVERNORATE'
          ? hasCentres
            ? 'CENTRE'
            : 'VILLAGE'
          : level === 'CENTRE'
            ? 'VILLAGE'
            : null;

  interface Child {
    id: string;
    code: string | null;
    name: string;
    villages: string[];
    matches: (a: GeoAnswer) => boolean;
    profileKey: string | null;
  }
  const children: Child[] = [];
  if (childKind === 'REGION') {
    // Kingdom: every region, so those without data show greyed out and
    // coverage counts all of them; the study's own regions otherwise.
    const regions = new Map<string, { name: string; code: string }>();
    for (const r of inputs.allRegions) regions.set(r.id, { name: r.name, code: r.code });
    for (const g of inputs.governorates)
      if (!regions.has(g.regionId))
        regions.set(g.regionId, { name: g.regionName, code: g.regionCode });
    for (const [id, { name, code }] of regions)
      children.push({
        id,
        code,
        name,
        villages: inputs.villages.filter((v) => v.regionId === id).map((v) => v.name),
        matches: (a) => a.regionId === id,
        profileKey: `REGION:${id}`,
      });
  } else if (childKind === 'GOVERNORATE') {
    for (const g of inputs.governorates)
      children.push({
        id: g.id,
        code: g.code,
        name: g.name,
        villages: inputs.villages.filter((v) => v.governorateId === g.id).map((v) => v.name),
        matches: (a) => a.governorateId === g.id,
        profileKey: `GOVERNORATE:${g.id}`,
      });
  } else if (childKind === 'CENTRE') {
    const centres = new Map<string, { name: string; code: string | null }>();
    for (const v of inputs.villages)
      if (v.centerId && v.centerName)
        centres.set(v.centerId, { name: v.centerName, code: v.centerCode });
    for (const a of inputs.answers)
      if (a.centerId && a.centerName && !centres.has(a.centerId))
        centres.set(a.centerId, { name: a.centerName, code: a.centerCode ?? null });
    for (const [id, { name, code }] of centres)
      children.push({
        id,
        code,
        name,
        villages: inputs.villages.filter((v) => v.centerId === id).map((v) => v.name),
        matches: (a) => a.centerId === id,
        profileKey: `CENTRE:${id}`,
      });
  } else if (childKind === 'VILLAGE') {
    for (const v of inputs.villages)
      children.push({
        id: v.name,
        code: null,
        name: v.name,
        villages: [v.name],
        matches: (a) => a.village === v.name,
        profileKey: villageUnitKey(v.governorateId, v.typedName),
      });
  }

  const villageWithData = (name: string) =>
    answers.some((a) => a.village === name && a.status === 'SCORED' && a.severity !== null);

  const geographyUnits: GeographyUnit[] = children.map((ch) => {
    const rows = answers.filter(ch.matches);
    const r = computeUnitRollups(rows, questions, settings);
    const h = households(rows);
    const pop = ch.profileKey ? (inputs.profiles.get(ch.profileKey)?.population ?? null) : null;
    const required = requiredFor(pop, study.marginOfError);
    const withData = ch.villages.filter(villageWithData).length;
    // Governorates: centres with data out of the governorate's centres in the
    // KSA reference — the interim unit until village master data exists.
    const centresTotal =
      childKind === 'GOVERNORATE' ? (inputs.centresByGovernorate.get(ch.id) ?? null) : null;
    const centresWithData =
      childKind === 'GOVERNORATE'
        ? new Set(
            rows
              .filter((a) => a.status === 'SCORED' && a.severity !== null && a.centerId)
              .map((a) => a.centerId),
          ).size
        : null;
    const minShare = inputs.governorateMinCentresPct;
    const scoreStatus: GeographyUnit['scoreStatus'] =
      h.valid === 0
        ? 'NO_DATA'
        : minShare != null && centresTotal
          ? pct(centresWithData ?? 0, centresTotal) >= minShare
            ? 'SHOWN'
            : 'NOT_SHOWN'
          : 'SHOWN';
    return {
      id: ch.id,
      code: ch.code,
      name: ch.name,
      villagesWithData: withData,
      villagesNamed: ch.villages.length,
      centresWithData,
      centresTotal,
      households: h.valid,
      required,
      needsIndex: r.overall?.severityScore != null ? round1(r.overall.severityScore) : null,
      scoreStatus,
      measuredDomains: [...r.domain.values()]
        .filter((d) => d.severityScore !== null)
        .map((d) => d.entityId)
        .sort(),
      confidence: h.valid ? sampleResultOf(h.valid, required, minimum) : null,
    };
  });

  // Units with data first, then those without (greyed), each by name.
  geographyUnits.sort(
    (a, b) => Number(b.households > 0) - Number(a.households > 0) || a.name.localeCompare(b.name),
  );
  const shown = geographyUnits.filter((u) => u.scoreStatus === 'SHOWN');
  // "Two units are ranked only when they are comparable on the same domains
  // and neither result is Low" (client, 15 Oct 2026): the units that meet the
  // standard are ranked among themselves; a Low unit is left out and named,
  // not allowed to block the others. Units without data are grey, never ranked.
  const rankable = shown.filter((u) => u.confidence === 'MEETS');
  const excludedLow = shown.filter((u) => u.confidence !== 'MEETS').map((u) => u.id);
  const sameDomains = rankable.every(
    (u) => u.measuredDomains.join('|') === rankable[0]?.measuredDomains.join('|'),
  );
  const comparable =
    rankable.length >= 2 &&
    shown.length === geographyUnits.filter((u) => u.scoreStatus !== 'NO_DATA').length &&
    sameDomains;
  const geography: CoreGeography = {
    show: geographyUnits.length > 1,
    unitKind: childKind ?? 'VILLAGE',
    mapLevel:
      childKind === 'REGION' || childKind === 'GOVERNORATE' || childKind === 'CENTRE'
        ? childKind
        : null,
    units: geographyUnits,
    mapContext: inputs.mapContext,
    ranking: {
      ranked: comparable,
      order: comparable
        ? [...rankable].sort((a, b) => (b.needsIndex ?? -1) - (a.needsIndex ?? -1)).map((u) => u.id)
        : [],
      excludedLow: comparable ? excludedLow : [],
    },
    scoreThresholdPct: inputs.governorateMinCentresPct,
  };

  // ── Sample distribution and concentration ──
  const concentratedFromPct = inputs.concentratedFromPct;
  const distribution: CoreEvidence['distribution'] = [];
  // The governorate each row's share is taken of (structure v2,
  // "Concentration": the share of a governorate's valid responses held by
  // one unit). Null for a region or governorate row, which is not a unit
  // within a governorate: its share is of the whole scope and never flagged.
  const shareOf: Array<string | null> = [];
  const villageGov = (name: string) => inputs.villages.find((v) => v.name === name)?.governorateId ?? null;
  const villageCounts = new Map<string, number>();
  for (const v of inputs.villages) {
    const n = households(answers.filter((a) => a.village === v.name)).valid;
    if (n > 0) villageCounts.set(v.name, n);
  }
  if (childKind && childKind !== 'VILLAGE') {
    // At Kingdom level only the regions the study covers: the others carry
    // no planned sample, so listing them at 0% says nothing.
    const studyRegionIds = new Set(inputs.governorates.map((g) => g.regionId));
    for (const ch of children) {
      if (childKind === 'REGION' && !studyRegionIds.has(ch.id)) continue;
      const own = ch.villages.filter((v) => villageCounts.has(v));
      if (own.length)
        for (const v of own) {
          distribution.push({ unit: v, parent: ch.name, n: villageCounts.get(v)!, sharePct: 0 });
          shareOf.push(villageGov(v));
        }
      else {
        const n = households(answers.filter(ch.matches)).valid;
        distribution.push({ unit: ch.name, parent: null, n, sharePct: 0 });
        shareOf.push(childKind === 'CENTRE' ? inputs.unit.id : null);
      }
    }
  } else {
    for (const v of inputs.villages) {
      distribution.push({
        unit: v.name,
        parent: null,
        n: villageCounts.get(v.name) ?? 0,
        sharePct: 0,
      });
      shareOf.push(v.governorateId);
    }
  }
  const distTotal = distribution.reduce((s, d) => s + d.n, 0);
  const governorateValid = new Map<string, number>();
  const validIn = (governorateId: string): number => {
    if (!governorateValid.has(governorateId))
      governorateValid.set(
        governorateId,
        households(answers.filter((a) => a.governorateId === governorateId)).valid,
      );
    return governorateValid.get(governorateId)!;
  };
  distribution.forEach((d, i) => {
    const g = shareOf[i];
    d.sharePct = pct(d.n, g ? validIn(g) : distTotal);
  });
  const withinGovernorate = distribution.filter((_, i) => shareOf[i] != null);
  const maxShare = withinGovernorate.reduce((m, d) => Math.max(m, d.sharePct), 0);
  const largestRow = (withinGovernorate.length ? withinGovernorate : distribution).reduce<
    (typeof distribution)[number] | null
  >((m, d) => (!m || d.sharePct > m.sharePct ? d : m), null);
  const multiUnit = distribution.length > 1;
  // No threshold until one is approved: the share is stated, never flagged.
  const concentration: CoreEvidence['concentration'] =
    // Each share is of the unit's own governorate, so one village holding
    // most of it is concentration even when it is the only one listed.
    distTotal === 0 || concentratedFromPct == null || !withinGovernorate.length
      ? null
      : maxShare >= 100
        ? 'FULLY_CONCENTRATED'
        : maxShare >= concentratedFromPct
          ? 'CONCENTRATED'
          : null;

  // ── Confidence: a breakdown of the v5.0 flag (client, 15 Oct 2026) ──
  const sampleResult = sampleResultOf(hh.valid, study.requiredSampleSize, minimum);
  const coverageTotal = children.length || 1;
  const coverageWith = children.length
    ? geographyUnits.filter((u) => u.households > 0).length
    : hh.valid > 0
      ? 1
      : 0;
  const coveragePct = pct(coverageWith, coverageTotal);
  // v5.0 defines no coverage threshold: descriptive until one is approved.
  const coverageResult: ConfidenceResult | null =
    inputs.coverageMinPct == null ? null : coveragePct >= inputs.coverageMinPct ? 'MEETS' : 'LOW';

  const validRatePct = pct(hh.valid, hh.submitted);
  const completenessResult: ConfidenceResult =
    hh.valid === 0 || dontKnowPct > dontKnowLimitPct ? 'LOW' : 'MEETS';

  const overall = anyLow(sampleResult, coverageResult, completenessResult);
  const confidence: ConfidenceComponents = {
    overall,
    sample: { valid: hh.valid, required: study.requiredSampleSize, minimum, result: sampleResult },
    coverage: {
      // With no units beneath it (a centre whose study names no villages),
      // coverage counts the area itself: "1 of 1 centres", not villages.
      unitKind: children.length || level === 'KINGDOM' ? (childKind ?? 'VILLAGE') : level,
      withData: coverageWith,
      total: coverageTotal,
      largest:
        multiUnit && largestRow && distTotal > 0
          ? { unit: largestRow.unit, sharePct: largestRow.sharePct }
          : null,
      concentration,
      thresholdPct: inputs.coverageMinPct,
      result: coverageResult,
    },
    completeness: { validRatePct, dontKnowPct, dontKnowLimitPct, result: completenessResult },
  };

  // ── Domains, ranked needs and the hierarchy ──
  // v5.0 no-masking rule (Domain Comparison sheet, client 23 Oct 2026): a
  // domain holding any KPI at or above the Critical threshold is flagged,
  // even when its average is lower.
  const domainsWithCriticalKpi = new Set(
    [...roll.kpi.values()]
      .filter((k) => k.severityScore !== null && round1(k.severityScore) >= tiers.critical)
      .map((k) => kpiMeta.get(k.entityId)?.domain)
      .filter((x): x is string => !!x),
  );
  const domainRows: CoreDomainRow[] = selectedDomains.map((d) => {
    const r = roll.domain.get(d.name);
    const severity = r?.severityScore != null ? round1(r.severityScore) : null;
    return {
      key: d.key,
      name: d.name,
      severity,
      weight: weightByKey.get(d.key) ?? null,
      band: aggregateTier(severity),
      criticalNeedPresent: domainsWithCriticalKpi.has(d.name),
    };
  });
  const measured = domainRows
    .filter((d) => d.severity !== null)
    .sort((a, b) => b.severity! - a.severity!);

  const whereFor = (kpi: string): string[] => {
    const qIds = new Set(
      [...questions.values()].filter((q) => q.kpi === kpi).map((q) => q.questionId),
    );
    // The village where named; until village master data arrives, the
    // governorate (Kingdom or region scope) or the centre (governorate or
    // centre scope). Highest average severity first, so the places named
    // first are where the need is greatest.
    const wide = inputs.unit.level === 'KINGDOM' || inputs.unit.level === 'REGION';
    const bySeverity = new Map<string, { sum: number; n: number }>();
    for (const a of answers) {
      if (!qIds.has(a.questionId) || a.status !== 'SCORED') continue;
      // A village below the minimum is not named (client, 15 Oct 2026): its
      // answers are placed at its centre or governorate instead.
      const village = a.village && (villageCounts.get(a.village) ?? 0) >= minimum ? a.village : null;
      const place =
        village ?? (wide ? a.governorateName : (a.centerName ?? a.governorateName)) ?? null;
      if (!place) continue;
      const s = bySeverity.get(place) ?? { sum: 0, n: 0 };
      s.sum += a.severity ?? 0;
      s.n += 1;
      bySeverity.set(place, s);
    }
    return [...bySeverity.entries()]
      .sort(([pa, a], [pb, b]) => b.sum / b.n - a.sum / a.n || pa.localeCompare(pb))
      .map(([place]) => place);
  };

  const kpiRows = [...roll.kpi.values()].filter(
    (k) => k.severityScore !== null && kpiMeta.has(k.entityId),
  );
  const ranked = kpiRows
    .map((k) => {
      const meta = kpiMeta.get(k.entityId)!;
      // A domain with no configured weight counts 0 here, not 1: weighting
      // it as a full domain put a 42-severity Governance KPI above a
      // 98-severity Health one (Health's weight is 0.3).
      const w = weightByKey.get(normalizeDomainKey(meta.domain)) ?? 0;
      return { k, meta, relevance: k.severityScore! * w };
    })
    // "Ranked by severity" (mockup): severity first; weighted relevance only
    // breaks ties.
    .sort(
      (a, b) =>
        b.k.severityScore! - a.k.severityScore! ||
        b.relevance - a.relevance ||
        b.k.validResponseCount - a.k.validResponseCount ||
        a.k.entityId.localeCompare(b.k.entityId),
    );

  const gapTypeFor = (kpi: string): GapType | null => {
    const qIds = new Set(
      [...questions.values()].filter((q) => q.kpi === kpi).map((q) => q.questionId),
    );
    const types = new Set<string>();
    for (const a of answers)
      if (qIds.has(a.questionId)) {
        const t = inputs.gapTypeBySurvey.get(a.surveyId);
        if (t) types.add(t);
      }
    return types.size === 1 ? ([...types][0] as GapType) : null;
  };

  const rankedNeeds: CoreRankedNeed[] = ranked
    .slice(0, cfg.rankedNeedsMax)
    .map(({ k, meta }, i) => {
      const severity = round1(k.severityScore!);
      return {
        rank: i + 1,
        kpiCode: splitKpi(k.entityId)[0],
        kpi: k.entityId,
        domain: meta.domain,
        subDomain: meta.subDomain,
        where: whereFor(k.entityId),
        actual: actualFor(k.entityId, answers),
        severity,
        band: tierOf(severity, tiers, kpiCriticalEligible(k.entityId), kpiEquityFlagged(k.entityId)),
        gapType: gapTypeFor(k.entityId),
      };
    });

  const targetGroupFor = (kpi: string): string | null => {
    const qIds = new Set(
      [...questions.values()].filter((q) => q.kpi === kpi).map((q) => q.questionId),
    );
    const groups = new Set<string>();
    for (const a of answers)
      if (qIds.has(a.questionId)) {
        const g = inputs.targetGroupBySurvey.get(a.surveyId);
        if (g) groups.add(g);
      }
    return groups.size ? [...groups].sort().join(' · ') : null;
  };

  const hierarchy: CoreHierarchyDomain[] = [];
  for (const d of selectedDomains) {
    const dr = roll.domain.get(d.name);
    if (!dr || dr.severityScore === null) continue;
    const subNames = unique(
      [...questions.values()].filter((q) => q.domain === d.name).map((q) => q.subDomain),
    );
    const subDomains = subNames
      .map((sub) => {
        const sr = roll.subDomain.get(sub);
        const indNames = unique(
          [...questions.values()]
            .filter((q) => q.domain === d.name && q.subDomain === sub && q.indicator)
            .map((q) => q.indicator!),
        );
        const indicators = indNames
          .map((ind) => {
            const kpis = unique(
              [...questions.values()]
                .filter((q) => q.indicator === ind && q.kpi)
                .map((q) => q.kpi!),
            )
              .map((kpi) => {
                const kr = roll.kpi.get(kpi);
                if (!kr) return null;
                const severity = kr.severityScore != null ? round1(kr.severityScore) : null;
                return {
                  code: splitKpi(kpi)[0],
                  name: kpi,
                  actual: actualFor(kpi, answers),
                  severity,
                  band: tierOf(severity, tiers, kpiCriticalEligible(kpi), kpiEquityFlagged(kpi)),
                  gapType: gapTypeFor(kpi),
                  targetGroup: targetGroupFor(kpi),
                  fit:
                    severity === null
                      ? null
                      : anyLow(
                            sampleResultOf(kr.validResponseCount, study.requiredSampleSize, minimum),
                            coverageResult,
                            completenessResult,
                          ) === 'MEETS'
                        ? ('FIT' as const)
                        : ('PRELIMINARY' as const),
                };
              })
              .filter((k): k is NonNullable<typeof k> => k !== null);
            return kpis.length ? { name: ind, kpis } : null;
          })
          .filter((i): i is NonNullable<typeof i> => i !== null);
        return indicators.length
          ? {
              name: sub,
              severity: sr?.severityScore != null ? round1(sr.severityScore) : null,
              indicators,
            }
          : null;
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
    hierarchy.push({ key: d.key, name: d.name, severity: round1(dr.severityScore), subDomains });
  }

  // ── Villages with data ──
  // Village results below the methodology minimum are not shown (client,
  // 15 Oct 2026); how many were left out is stated under the table.
  const villagesBelowMinimum = inputs.villages.filter(
    (v) => (villageCounts.get(v.name) ?? 0) > 0 && villageCounts.get(v.name)! < minimum,
  ).length;
  const villageRows: CoreVillageRow[] = inputs.villages
    .filter((v) => (villageCounts.get(v.name) ?? 0) >= minimum)
    .map((v) => {
      const rows = answers.filter((a) => a.village === v.name);
      const r = computeUnitRollups(rows, questions, settings);
      const pop = inputs.profiles.get(villageUnitKey(v.governorateId, v.typedName))?.population ?? null;
      const required = requiredFor(pop, study.marginOfError) ?? study.requiredSampleSize;
      const priority = villagePriority(r, inputs);
      const idx = r.overall?.severityScore != null ? round1(r.overall.severityScore) : null;
      const n = villageCounts.get(v.name)!;
      return {
        name: v.name,
        governorate: v.governorateName,
        population: pop,
        needsIndex: idx,
        needsIndexBand: aggregateTier(idx),
        priorityScore: priority ? round1(priority.priorityScore) : null,
        priorityStatus: priority?.priorityStatus ?? null,
        responses: n,
        confidence: sampleResultOf(n, required, minimum),
      };
    })
    .sort((a, b) => (b.needsIndex ?? -1) - (a.needsIndex ?? -1) || a.name.localeCompare(b.name))
    .slice(0, level === 'KINGDOM' ? cfg.villagesTopAtKingdom : undefined);

  // ── Links between indicators (points to confirm #7) ──
  const links = computeLinks(answers, questions, inputs.linkPairs, cfg);

  // ── Evidence and data quality ──
  const unitResponses = inputs.responses;
  const gender = { male: 0, female: 0, unspecified: 0 };
  const ages = new Map<string, number>();
  for (const r of unitResponses) {
    if (r.gender === 'male') gender.male++;
    else if (r.gender === 'female') gender.female++;
    else gender.unspecified++;
    if (r.ageBracket && r.ageBracket !== 'prefer_not_to_say')
      ages.set(r.ageBracket, (ages.get(r.ageBracket) ?? 0) + 1);
  }
  const AGE_ORDER = [
    'age_15_24',
    'age_25_34',
    'age_35_44',
    'age_45_54',
    'age_55_64',
    'age_65_plus',
  ];
  const age = AGE_ORDER.filter((b) => ages.has(b)).map((band) => ({
    band,
    count: ages.get(band)!,
  }));

  const fitToPublish: CoreEvidence['fitToPublish'] = selectedDomains.map((d) => {
    const r = roll.domain.get(d.name);
    if (!r || r.severityScore === null)
      return {
        key: d.key,
        name: d.name,
        status: 'NOT_MEASURED',
        valid: 0,
        required: study.requiredSampleSize,
        unitsWithData: 0,
        unitsTotal: coverageTotal,
      };
    const result = anyLow(
      sampleResultOf(r.validResponseCount, study.requiredSampleSize, minimum),
      coverageResult,
      completenessResult,
    );
    return {
      key: d.key,
      name: d.name,
      status: result === 'MEETS' ? 'FIT' : 'PRELIMINARY',
      valid: r.validResponseCount,
      required: study.requiredSampleSize,
      unitsWithData: coverageWith,
      unitsTotal: coverageTotal,
    };
  });

  const collectNext: CoreEvidence['collectNext'] = [];
  if (study.requiredSampleSize != null && hh.valid < study.requiredSampleSize) {
    const withData = [...villageCounts.keys()];
    collectNext.push({
      kind: 'MORE_HOUSEHOLDS',
      count: study.requiredSampleSize - hh.valid,
      where: withData.length === 1 ? withData[0]! : (inputs.unit.name ?? study.title),
    });
  }
  // Only units the study covers: at Kingdom level the other regions are shown
  // for coverage, but asking this study to survey them would be wrong.
  const studyRegions = new Set(inputs.governorates.map((g) => g.regionId));
  const noData = geographyUnits
    .filter(
      (u) => u.scoreStatus === 'NO_DATA' && (childKind !== 'REGION' || studyRegions.has(u.id)),
    )
    .map((u) => u.name);
  if (noData.length) collectNext.push({ kind: 'UNITS_WITHOUT_DATA', units: noData });
  for (const u of geographyUnits.filter((x) => x.scoreStatus === 'NOT_SHOWN'))
    collectNext.push({ kind: 'MORE_VILLAGES', where: u.name });
  const unmeasured = domainRows.filter((d) => d.severity === null).length;
  if (unmeasured) collectNext.push({ kind: 'UNMEASURED_DOMAINS', count: unmeasured });
  if (!age.length) collectNext.push({ kind: 'AGE_BANDS' });

  const scoredResponseIds = new Set(
    unitAnswers
      .filter((a) => a.status === 'SCORED' && a.severity !== null)
      .map((a) => a.responseId),
  );
  const evidence: CoreEvidence = {
    distribution,
    concentration,
    concentratedFromPct,
    responses: {
      submitted: hh.submitted,
      valid: hh.valid,
      duplicate: unitResponses.filter((r) => r.duplicate).length,
      // An exclusion count: a response flagged low confidence but still
      // scored is not excluded (the flag is set on every response of a batch
      // below the minimum, which the sample component already reports).
      lowConfidence: unitResponses.filter((r) => r.lowConfidence && !scoredResponseIds.has(r.id))
        .length,
      incomplete: unitResponses.filter((r) => r.incomplete).length,
      answersExcluded,
      outsideGeography: inputs.outsideGeography,
      totalAnswers: unitAnswers.length,
      dontKnowPct,
      dontKnowLimitPct,
    },
    gender,
    age,
    fitToPublish,
    collectNext,
  };

  // ── Documented need cards ──
  // Estimated beneficiaries scale the sample's share to the population the
  // sample was drawn for — the study's own population, which its required
  // sample comes from. That base holds only when the report covers the whole
  // study (Kingdom scope); a region or governorate slice of the sample does
  // not represent that area (client tracker, comment 44), so no estimate is
  // given there. A single village keeps its entered population, as the
  // structure asks for village scope.
  const studyPopulation = inputs.unit.level === 'KINGDOM' ? (study.population ?? null) : null;
  // A card documents a need: a KPI at Low priority, or with no gap, is not one.
  const needCards: CoreNeedCard[] = rankedNeeds
    .filter((n) => n.band !== 'LOW' && n.severity > 0)
    .slice(0, cfg.needCardsMax)
    .map((n) => {
      const where = n.where;
      const pop =
        where.length === 1
          ? (() => {
              const v = inputs.villages.find((x) => x.name === where[0]);
              return (
                inputs.profiles.get(villageUnitKey(v?.governorateId ?? null, v?.typedName ?? where[0]!))
                  ?.population ?? null
              );
            })()
          : studyPopulation;
      const beneficiaries =
        n.actual?.kind === 'PCT' && pop
          ? {
              pct: n.actual.notMetPct,
              population: pop,
              people: Math.round((n.actual.notMetPct / 100) * pop),
            }
          : null;
      return {
        kpi: n.kpi,
        domain: n.domain,
        location: cardLocation(where, inputs),
        beneficiaries,
        evidence: {
          valid: hh.valid,
          required: study.requiredSampleSize,
          villages: villageCounts.size,
          result: overall,
        },
        otherOrganisations: inputs.otherOrganisations,
        // Not listed while the result is LOW ("Preliminary – not fit to publish").
        eligible: overall === 'MEETS',
      };
    });

  // ── The decision summary ──
  const needsIndex =
    roll.overall?.severityScore != null ? round1(roll.overall.severityScore) : null;
  const top = measured[0] ?? null;
  const findingsSource = top ? rankedNeeds.filter((n) => n.domain === top.name) : rankedNeeds;
  const summary = {
    needsIndex,
    needsIndexBand: aggregateTier(needsIndex),
    topDomain: top ? { key: top.key, name: top.name, score: top.severity! } : null,
    findings: (findingsSource.length ? findingsSource : rankedNeeds)
      .slice(0, 2)
      .map((n) => ({ kpi: n.kpi, actual: n.actual, severity: n.severity })),
    otherDomains: measured
      .slice(1, 3)
      .map((d) => ({ key: d.key, name: d.name, score: d.severity! })),
    // Named in the summary sentence, so only villages at the minimum.
    villagesWithData: [...villageCounts].filter(([, n]) => n >= minimum).map(([v]) => v),
    unitsWithoutData: noData,
    decision: coreDecisionFor(overall, measured[0]?.band ?? aggregateTier(needsIndex)),
  };

  const profileKey = unitProfileKey(inputs);
  return {
    kind: 'CORE_NEEDS',
    version: 2,
    output: input.output,
    header: {
      studyName: study.title,
      organizationName: study.organizationName,
      scopeLevel: level,
      unitName: inputs.unit.name,
      parents: inputs.unit.parents,
      domains: selectedDomains.map((d) => ({ key: d.key, name: d.name })),
      allDomains: selectedDomains.length === inputs.allDomains.length,
      collectedFrom: inputs.collectedFrom?.toISOString() ?? null,
      collectedTo: inputs.collectedTo?.toISOString() ?? null,
      collectionSources: inputs.needSources,
      selectionApproach: inputs.survey.selectionApproach,
      methodologyVersion: study.methodologyVersionLabel,
      generatedAt: input.generatedAt,
    },
    profile: {
      figures: profileKey ? (inputs.profiles.get(profileKey) ?? null) : null,
      governorates:
        level === 'KINGDOM' || level === 'REGION'
          ? { inStudy: inputs.governorates.length, total: inputs.governoratesInUnitTotal }
          : null,
      villages: { withData: villageCounts.size, named: inputs.villages.length },
      centres:
        level === 'GOVERNORATE' && childKind === 'CENTRE'
          ? {
              withData: geographyUnits.filter((u) => u.households > 0).length,
              total: inputs.unit.id ? (inputs.centresByGovernorate.get(inputs.unit.id) ?? null) : null,
            }
          : null,
    },
    confidence,
    summary,
    geography,
    villages: villageRows,
    villagesBelowMinimum,
    rankedNeeds,
    domains: domainRows,
    hierarchy,
    methodologySplit: inputs.methodologySplit,
    targetGroup: inputs.survey.targetGroup,
    reading: {
      requiredSample: study.requiredSampleSize,
      population: study.population,
      marginOfErrorPct: study.marginOfError != null ? round1(study.marginOfError * 100) : null,
      minimumDetectableEffect:
        study.minimumDetectableEffect != null ? round1(study.minimumDetectableEffect) : null,
    },
    links,
    evidence,
    needCards,
    tiers: { critical: tiers.critical, high: tiers.high, medium: tiers.medium },
    filters: input.filters,
  };
}

/** Village › centre › governorate › region for a need card, as the mockup
 *  ("Al Aham, Ad-Dawadmi, Riyadh"). Falls back to the selected area. */
function cardLocation(where: string[], inputs: CoreInputs): string[] {
  const geo = inputs.villages.find((v) => v.name === where[0]);
  // No village: the governorates or centres the need was measured in.
  if (!geo && where.length) return where.slice(0, 3);
  if (!geo) return [inputs.unit.name, ...inputs.unit.parents].filter((x): x is string => !!x);
  return [
    ...where.slice(0, 3),
    ...[geo.centerName, geo.governorateName, geo.regionName].filter(
      (x): x is string => !!x && !where.includes(x),
    ),
  ];
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** "HLT-01 — % of …" → ["HLT-01", "% of …"]; a KPI with no code keeps its name. */
export function splitKpi(kpi: string): [string, string] {
  const m = /^([A-Z]{2,5}-\d{1,3}[a-z]?)\s*[—–-]\s*(.+)$/.exec(kpi.trim());
  return m ? [m[1]!, m[2]!.trim()] : ['', kpi.trim()];
}

function unitProfileKey(inputs: CoreInputs): string | null {
  const { level, id } = inputs.unit;
  if (level === 'KINGDOM') return 'KINGDOM';
  if (!id) return null;
  if (level === 'VILLAGE') {
    const v = inputs.villages.find((x) => x.name === (inputs.unit.name ?? id.trim()));
    return villageUnitKey(v?.governorateId ?? null, v?.typedName ?? id);
  }
  return `${level}:${id}`;
}

function villagePriority(r: UnitRollups, inputs: CoreInputs) {
  if (!inputs.domainConfigs.length) return null;
  const scores = new Map<string, number>();
  for (const d of r.domain.values())
    if (d.severityScore !== null) scores.set(normalizeDomainKey(d.entityId), d.severityScore);
  if (!scores.size) return null;
  return computeVillagePriority(inputs.domainConfigs, scores);
}

/**
 * Links between indicators (client, 15 Oct 2026): only the pairs held in the
 * methodology configuration. For each pair, respondents whose need on KPI A
 * is not fully met against those whose need is met: what share of each group
 * also has an unmet need on KPI B. A hypothesis to test, never a cause, and
 * "Insufficient data for analysis" below the minimum per group.
 */
function computeLinks(
  answers: GeoAnswer[],
  questions: Map<string, QuestionMeta>,
  pairs: Array<[string, string]>,
  cfg: CoreNeedsConfig,
): CoreLinks {
  const kpiOfQuestion = new Map(
    [...questions.values()].filter((q) => q.kpi).map((q) => [q.questionId, q.kpi!]),
  );
  const known = new Set(kpiOfQuestion.values());
  // KPIs match by their code ("HLT-01") or by their full methodology name.
  const resolve = (k: string): string | null =>
    known.has(k) ? k : ([...known].find((x) => splitKpi(x)[0] === k.trim()) ?? null);
  const max = new Map<string, Map<string, number>>(); // response -> kpi -> highest severity
  for (const a of dedupe(answers)) {
    if (a.status !== 'SCORED' || a.severity === null) continue;
    const kpi = kpiOfQuestion.get(a.questionId);
    if (!kpi) continue;
    const per = max.get(a.responseId) ?? new Map<string, number>();
    per.set(kpi, Math.max(per.get(kpi) ?? 0, a.severity));
    max.set(a.responseId, per);
  }
  const items: CoreLinks['items'] = [];
  for (const [rawA, rawB] of pairs) {
    const A = resolve(rawA);
    const B = resolve(rawB);
    if (!A || !B) continue;
    let withA = 0,
      withABoth = 0,
      withoutA = 0,
      withoutABoth = 0;
    for (const per of max.values()) {
      const a = per.get(A);
      const b = per.get(B);
      if (a === undefined || b === undefined) continue;
      if (a > 0) {
        withA++;
        if (b > 0) withABoth++;
      } else {
        withoutA++;
        if (b > 0) withoutABoth++;
      }
    }
    items.push({
      kpiA: A,
      kpiB: B,
      sufficient: withA >= cfg.linksMinPerGroup && withoutA >= cfg.linksMinPerGroup,
      pctWithA: pct(withABoth, withA),
      pctWithoutA: pct(withoutABoth, withoutA),
      nA: withA,
      nWithoutA: withoutA,
    });
  }
  return { pairsConfigured: pairs.length, minPerGroup: cfg.linksMinPerGroup, items };
}
