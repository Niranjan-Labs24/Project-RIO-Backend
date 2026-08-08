import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { Prisma } from '../../generated/prisma';
import { requireOrgId, getOrgStore } from '../../tenancy/org-context';
import { AiService } from '../ai/ai.service';
import type { AiTask } from '../ai/ai.task';
import {
  PRIORITY_DASHBOARD_SUMMARY_RESPONSE_SCHEMA,
} from '../ai/prompts/priority-dashboard-summary.system';
import {
  VILLAGE_REPORT_SUMMARY_PROMPT_VERSION,
  VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT,
} from '../ai/prompts/village-report-summary.system';
import {
  SECTOR_REPORT_SUMMARY_PROMPT_VERSION,
  SECTOR_REPORT_SUMMARY_SYSTEM_PROMPT,
} from '../ai/prompts/sector-report-summary.system';
import {
  REGION_REPORT_SUMMARY_PROMPT_VERSION,
  REGION_REPORT_SUMMARY_SYSTEM_PROMPT,
} from '../ai/prompts/region-report-summary.system';
import {
  EXECUTIVE_REPORT_SUMMARY_PROMPT_VERSION,
  EXECUTIVE_REPORT_SUMMARY_SYSTEM_PROMPT,
} from '../ai/prompts/executive-report-summary.system';
import {
  INDIVIDUAL_SURVEY_SUMMARY_PROMPT_VERSION,
  INDIVIDUAL_SURVEY_SUMMARY_RESPONSE_SCHEMA,
  INDIVIDUAL_SURVEY_SUMMARY_SYSTEM_PROMPT,
} from '../ai/prompts/individual-survey-summary.system';
import {
  COMBINED_REPORT_SUMMARY_PROMPT_VERSION,
  COMBINED_REPORT_SUMMARY_RESPONSE_SCHEMA,
  COMBINED_REPORT_SUMMARY_SYSTEM_PROMPT,
} from '../ai/prompts/combined-report-summary.system';
import { normalizeDomainKey, type DomainPriorityComponent } from '../priority/priority-v2.service';
import { aggregateDemographics } from './providers/aggregate-demographics';
import { resolveKpiDomain } from './providers/survey-report-derivations';
import {
  composeConfidenceReason,
  dontKnowBandOf,
  type DontKnowBand,
} from './providers/severity-bands';
import { DEFAULT_THRESHOLDS, type UnitGeo } from './need-record.types';
import { buildUnitGeo } from './providers/resolve-geography';
import {
  snapshotToExecutiveContent,
  snapshotToRegionContent,
  snapshotToSectorContent,
  snapshotToVillageContent,
} from './providers/snapshot-to-content';

// VILLAGE/SECTOR/REGION/EXECUTIVE are the Insights-page scopes. INDIVIDUAL and
// COMBINED are the survey-scoped report scopes (RPT01 / RPT15) — same snapshot
// shape and the same survey-level rollup query as VILLAGE, but each gets its own
// system prompt and response schema so the narrative matches what the report
// actually shows. Stored in AiPrioritySummary.summaryScope (VarChar(50)), so
// adding values needs no migration.
export type SummaryScopeType =
  | 'VILLAGE'
  | 'SECTOR'
  | 'REGION'
  | 'EXECUTIVE'
  | 'INDIVIDUAL'
  | 'COMBINED';

/** Scopes that describe ONE survey — evidence and rollups scope to its Need. */
export const SURVEY_LEVEL_SCOPES: SummaryScopeType[] = ['VILLAGE', 'INDIVIDUAL', 'COMBINED'];

export interface ScopeFilters {
  villageId?: string;
  domainKey?: string;
  regionId?: string;
  villageIds?: string[];
}

/** A SUB_DOMAIN or INDICATOR ScoreRollup row, narrowed to what a report needs. */
export interface RollupLevelRow {
  entityId: string;
  entityName: string;
  severityScore: number | null;
  confidenceLevel: string;
  validResponseCount: number;
  dontKnowRate: number;
}

/** A KPI ScoreRollup row — the atom every Unified Need Record is built from. */
export interface KpiRollupSnapshotRow extends RollupLevelRow {
  excludedResponseCount: number;
  dontKnowCount: number;
  notApplicableCount: number;
}

export interface ReportDataSnapshot {
  snapshotId: string;
  generatedAt: string;
  scope: SummaryScopeType;
  scopeFilters: ScopeFilters;
  study: {
    studyId: string;
    studyName: string;
    surveyId: string;
    villageId: string;
    villageName: string;
    assessmentCycle: number;
    organizationName: string;
    methodologyVersionId: string;
    // Human-readable version label (e.g. "v1.0") for the report header — the
    // UUID methodologyVersionId is an internal key, never shown to users.
    methodologyVersionLabel?: string;
    // Study's governorate name(s), joined; null when none selected. Feeds the
    // region report's Governorate column.
    governorateName: string | null;
    // Region name(s) where the study was conducted (parent of the selected
    // governorates); null when none selected. Feeds the region report's Region
    // Name column.
    regionName: string | null;
    // RIO-FR-024: computed once at study creation (StudiesService/sample-size.ts)
    // — null for studies created before this field existed.
    population: number | null;
    requiredSampleSize: number | null;
    minimumDetectableEffect: number | null;
  };
  responseQuality: {
    submittedResponseCount: number;
    validResponseCount: number;
    dontKnowRate: number;
    confidenceLevel: string;
    // Names ONLY the condition that actually fired (sample size vs don't-know
    // rate). This used to be a fixed string asserting a high don't-know rate
    // whenever confidence was LOW — false whenever LOW came from sample size,
    // which is the common case. The snapshot handed that false premise to
    // Gemini, which faithfully wrote a self-contradicting sentence.
    confidenceReason: string;
    /** Backend-decided adjective — the prompt must use it verbatim. */
    dontKnowBand: DontKnowBand;
  };
  severity: {
    overallVillageNeedsIndex: number | null;
    severityBand: string;
    domainSeverityScores: Array<{
      domainKey: string;
      domainName: string;
      severityScore: number | null;
      confidenceLevel: string;
      validResponseCount: number;
      // Excluded responses for this domain — with validResponseCount gives the
      // submitted total, so the report can show a quantitative confidence %
      // (valid / submitted). dontKnowRate carried alongside for the note.
      excludedResponseCount: number;
      dontKnowRate: number;
      // Number of methodology KPIs defined under this domain.
      kpiCount: number;
    }>;
    topKpis: Array<{
      rank: number;
      kpiName: string;
      indicatorName: string;
      domainName: string;
      severityScore: number | null;
      confidenceLevel: string;
      validResponseCount: number;
    }>;
    // The two rollup levels between KPI and DOMAIN. RollupService has always
    // computed and persisted them (question → KPI → indicator → sub-domain →
    // domain); the snapshot simply never read them, which is why the report
    // flattened a four-level methodology into one list of domains. Reading them
    // is what delivers the client's "classification by domain, sub-domain and
    // indicator" — no pipeline change, the rows already exist.
    subDomainSeverityScores: RollupLevelRow[];
    indicatorSeverityScores: RollupLevelRow[];
    /** EVERY KPI rollup for this scope, not just the top ten. One Unified Need
     *  Record is derived per row. */
    kpiSeverityScores: KpiRollupSnapshotRow[];
  };
  priority: {
    // NULL when no assessment is stored. The old `0` + `'LOW'` fallback
    // contradicted the banding itself (≤40 → HIGH), so an unscored village was
    // reported as the least urgent one in the study.
    villagePriorityScore: number | null;
    priorityStatus: 'HIGH' | 'MEDIUM' | 'LOW' | null;
    domainPerformanceScores: Array<{
      domainKey: string;
      domainName: string;
      severityScore: number;
      performanceScore: number;
      weight: number;
      weightedContribution: number;
      isCriticalDomain: boolean;
      triggeredOverride: boolean;
    }>;
    overrideApplied: boolean;
    overrideReason: string | null;
    calculatedAt: string;
  };
  /** Questions THIS survey actually asked, per methodology domain. Distinct
   *  from the number of KPIs the methodology defines under that domain — the
   *  "Questions per Domain" chart used to plot the latter under the former's
   *  label, so a 5-question survey reported 16 questions in one domain. */
  questionsAskedByDomain: Array<{ domain: string; domainKey: string; count: number }>;
  /** Canonical geography — ONE resolver feeds the header, this AI snapshot and
   *  the coverage block, so the narrative cannot name a different set of
   *  governorates than the report header does. Survey-level scopes only. */
  unitGeo: UnitGeo | null;
  evidence: Array<{
    id: string;
    evidenceTitle: string;
    type: string;
    sourceReferenceId: string;
    linkedDomainOrKpi: string;
    description: string;
    collectedDate: string;
  }>;
}

/** ScoreRollup row → the narrow shape the snapshot carries. Same `!= null`
 *  severity rule as everywhere else — a measured 0.00 survives as 0. */
function toRollupLevelRow(r: {
  entityId: string;
  entityNameSnapshot: string;
  severityScore: Prisma.Decimal | null;
  confidenceLevel: string;
  validResponseCount: number;
  dontKnowRate: Prisma.Decimal;
}): RollupLevelRow {
  return {
    entityId: r.entityId,
    entityName: r.entityNameSnapshot,
    severityScore: r.severityScore != null ? Number(r.severityScore) : null,
    confidenceLevel: r.confidenceLevel,
    validResponseCount: r.validResponseCount,
    dontKnowRate: Number(r.dontKnowRate),
  };
}

@Injectable()
export class ReportSummaryService {
  private readonly logger = new Logger(ReportSummaryService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly aiService: AiService,
  ) {}

  // Each scope carries its own system prompt AND response schema — a narrative
  // that promises "coverage" or "positioning" fields the schema doesn't declare
  // would be silently dropped by the structured-output call.
  private getPromptForScope(scope: SummaryScopeType): {
    promptVersion: string;
    systemPrompt: string;
    responseSchema: Record<string, unknown>;
  } {
    switch (scope) {
      case 'INDIVIDUAL':
        return {
          promptVersion: INDIVIDUAL_SURVEY_SUMMARY_PROMPT_VERSION,
          systemPrompt: INDIVIDUAL_SURVEY_SUMMARY_SYSTEM_PROMPT,
          responseSchema: INDIVIDUAL_SURVEY_SUMMARY_RESPONSE_SCHEMA,
        };
      case 'COMBINED':
        return {
          promptVersion: COMBINED_REPORT_SUMMARY_PROMPT_VERSION,
          systemPrompt: COMBINED_REPORT_SUMMARY_SYSTEM_PROMPT,
          responseSchema: COMBINED_REPORT_SUMMARY_RESPONSE_SCHEMA,
        };
      case 'SECTOR':
        return {
          promptVersion: SECTOR_REPORT_SUMMARY_PROMPT_VERSION,
          systemPrompt: SECTOR_REPORT_SUMMARY_SYSTEM_PROMPT,
          responseSchema: PRIORITY_DASHBOARD_SUMMARY_RESPONSE_SCHEMA,
        };
      case 'REGION':
        return {
          promptVersion: REGION_REPORT_SUMMARY_PROMPT_VERSION,
          systemPrompt: REGION_REPORT_SUMMARY_SYSTEM_PROMPT,
          responseSchema: PRIORITY_DASHBOARD_SUMMARY_RESPONSE_SCHEMA,
        };
      case 'EXECUTIVE':
        return {
          promptVersion: EXECUTIVE_REPORT_SUMMARY_PROMPT_VERSION,
          systemPrompt: EXECUTIVE_REPORT_SUMMARY_SYSTEM_PROMPT,
          responseSchema: PRIORITY_DASHBOARD_SUMMARY_RESPONSE_SCHEMA,
        };
      case 'VILLAGE':
      default:
        return {
          promptVersion: VILLAGE_REPORT_SUMMARY_PROMPT_VERSION,
          systemPrompt: VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT,
          responseSchema: PRIORITY_DASHBOARD_SUMMARY_RESPONSE_SCHEMA,
        };
    }
  }

  /** The prompt version a scope currently generates against. Callers compare it
   *  against a stored summary's `promptVersion` to decide whether that summary
   *  is still reusable — a narrative written by an older prompt can contradict
   *  the corrected snapshot it is printed beside. */
  promptVersionFor(scope: SummaryScopeType): string {
    return this.getPromptForScope(scope).promptVersion;
  }

  /**
   * Build a frozen server-generated ReportData snapshot for Gemini.
   */
  async buildReportDataSnapshot(
    studyId: string,
    surveyId: string,
    scope: SummaryScopeType = 'VILLAGE',
    scopeFilters: ScopeFilters = {},
  ): Promise<{
    snapshot: ReportDataSnapshot;
    reportDataHash: string;
    evidenceHash: string;
  }> {
    const villageId = scopeFilters.villageId || '';

    return this.tenant.runInOrgContext(async (tx) => {
      const study = await tx.study.findUnique({
        where: { id: studyId },
        include: {
          org: true,
          studyGovernorates: { include: { governorate: { include: { region: true } } } },
        },
      });
      if (!study) throw new NotFoundException('Study not found');

      // Governorate name(s) for the region report — a study may select several,
      // so join their names; null (→ "–") when the study has none selected.
      const governorateName =
        study.studyGovernorates.map((sg) => sg.governorate.name).join(', ') || null;

      // Region name(s) where the study was conducted — derived from the selected
      // governorates' parent Region. Distinct + joined; null when none selected,
      // so the report falls back to the study name.
      const regionName =
        [...new Set(study.studyGovernorates.map((sg) => sg.governorate.region.name))].join(', ') ||
        null;

      const survey = await tx.survey.findUnique({
        where: { id: surveyId },
      });
      if (!survey) throw new NotFoundException('Survey not found');

      const responses = await tx.surveyResponse.findMany({
        where: { needId: survey.needId },
      });

      const mv = await tx.methodologyVersion.findFirst({
        where: survey.methodologyVersion ? { version: survey.methodologyVersion } : { status: 'PUBLISHED' },
        orderBy: { createdAt: 'desc' },
      });
      if (!mv) throw new BadRequestException('No methodology version configured');

      // ScoreRollup is unique per villageId, and RollupService writes BOTH a
      // study-wide row (villageId '' — Prisma can't put null in a unique
      // constraint, see its upsert comment) and one row per village. Omitting
      // the filter when no village is selected therefore matched the
      // consolidated row *and* every per-village row, so each domain appeared
      // once per village in the table, the bars, the radar and the trend notes.
      //
      // Always filter, using '' for the consolidated case — the exact
      // convention PriorityService.getDashboard uses (`const vId = villageId
      // || ''`), which is also what makes these reports reconcile with the
      // Priority Dashboard rather than double-counting against it.
      const rollupVillageId = villageId || '';

      const overallRollup = await tx.scoreRollup.findFirst({
        where: {
          studyId,
          surveyId,
          methodologyVersionId: mv.id,
          rollupLevel: 'OVERALL',
          villageId: rollupVillageId,
        },
      });

      let domainRollups = await tx.scoreRollup.findMany({
        where: {
          studyId,
          surveyId,
          methodologyVersionId: mv.id,
          rollupLevel: 'DOMAIN',
          villageId: rollupVillageId,
        },
      });

      if (scope === 'SECTOR' && scopeFilters.domainKey) {
        domainRollups = domainRollups.filter((d) => d.entityId === scopeFilters.domainKey);
      }

      // Count the methodology KPIs contributing to each domain's severity. The
      // KPI→domain link isn't carried on ScoreRollup (KPI rollups don't store
      // their parent domain), so we read it from the Question set: distinct
      // non-null `kpi` grouped by normalized domain. We use the SAME selector
      // the scoring pipeline uses (`usedInMvp: true`, not methodologyVersionId —
      // questions may carry a null methodologyVersionId) so this count reflects
      // the real KPIs that actually fed the rollups. Keyed by normalized domain
      // to join onto the domain rollups (whose entityId is the domain name).
      const methodologyQuestions = await tx.question.findMany({
        where: { usedInMvp: true, kpi: { not: null } },
        select: { domain: true, kpi: true, indicator: true },
      });

      // Questions THIS survey asked, by domain. SurveyQuestion.questionId is the
      // Question ROW id (uuid), not the bank's `questionId` code — joining on the
      // wrong one silently produced zero for every domain. Custom questions carry
      // their own domain on the SurveyQuestion row.
      // Canonical geography, read inside this same transaction so nothing opens
      // a nested one. Survey-level scopes only: an aggregate scope spans many
      // needs and has no single unit geography.
      let unitGeo: UnitGeo | null = null;
      if (SURVEY_LEVEL_SCOPES.includes(scope)) {
        const [need, governorateLinks, centerLinks] = await Promise.all([
          tx.need.findUnique({ where: { id: survey.needId }, select: { village: true } }),
          tx.needGovernorate.findMany({
            where: { needId: survey.needId },
            include: { governorate: { include: { region: true } } },
          }),
          tx.needCenter.findMany({ where: { needId: survey.needId }, include: { center: true } }),
        ]);
        unitGeo = buildUnitGeo({
          needVillages: need?.village ?? [],
          studyVillages: study.villages ?? [],
          governorates: governorateLinks.map((g) => ({
            id: g.governorateId,
            name: g.governorate.name,
            regionId: g.governorate.regionId,
            regionName: g.governorate.region.name,
          })),
          centers: centerLinks.map((c) => ({ id: c.centerId, name: c.center.name })),
          villageId: villageId || undefined,
        });
      }

      const surveyQuestionRows = await tx.surveyQuestion.findMany({
        where: { surveyId },
        select: { domain: true, question: { select: { domain: true } } },
      });
      const askedByDomainKey = new Map<string, { domain: string; count: number }>();
      for (const sq of surveyQuestionRows) {
        const domain = sq.question?.domain ?? sq.domain;
        if (!domain) continue;
        const key = normalizeDomainKey(domain);
        const cell = askedByDomainKey.get(key) ?? { domain, count: 0 };
        cell.count += 1;
        askedByDomainKey.set(key, cell);
      }
      const kpiCountByDomainKey = new Map<string, Set<string>>();
      // KPI rollups store entityId = entityNameSnapshot = the KPI name (see
      // RollupService's KPI upsert), and carry no parent domain/indicator of
      // their own. Same Question set, same pass — so the Top KPIs table can
      // name a real domain and indicator instead of a hard-coded placeholder.
      const domainByKpi = new Map<string, string>();
      const indicatorByKpi = new Map<string, string>();
      for (const q of methodologyQuestions) {
        if (!q.kpi) continue;
        const key = normalizeDomainKey(q.domain);
        const set = kpiCountByDomainKey.get(key) ?? new Set<string>();
        set.add(q.kpi);
        kpiCountByDomainKey.set(key, set);
        if (!domainByKpi.has(q.kpi)) domainByKpi.set(q.kpi, q.domain);
        if (q.indicator && !indicatorByKpi.has(q.kpi)) indicatorByKpi.set(q.kpi, q.indicator);
      }

      // The two intermediate rollup levels. Mirrors the DOMAIN query exactly —
      // same villageId filter, or these duplicate per village the way the KPI
      // query used to.
      const [subDomainRollups, indicatorRollups, allKpiRollups] = await Promise.all([
        tx.scoreRollup.findMany({
          where: {
            studyId,
            surveyId,
            methodologyVersionId: mv.id,
            rollupLevel: 'SUB_DOMAIN',
            villageId: rollupVillageId,
          },
        }),
        tx.scoreRollup.findMany({
          where: {
            studyId,
            surveyId,
            methodologyVersionId: mv.id,
            rollupLevel: 'INDICATOR',
            villageId: rollupVillageId,
          },
        }),
        // EVERY KPI rollup, ordered deterministically — one need record per row.
        // Distinct from the `take: 10` query below, which only feeds the Top
        // KPIs table.
        tx.scoreRollup.findMany({
          where: {
            studyId,
            surveyId,
            methodologyVersionId: mv.id,
            rollupLevel: 'KPI',
            villageId: rollupVillageId,
          },
          orderBy: { entityId: 'asc' },
        }),
      ]);

      const kpiRollups = await tx.scoreRollup.findMany({
        where: {
          studyId,
          surveyId,
          methodologyVersionId: mv.id,
          rollupLevel: 'KPI',
          // Same per-village duplication as the DOMAIN query above — without
          // this the Top KPIs table listed each KPI once per village.
          villageId: rollupVillageId,
        },
        // Postgres defaults DESC to NULLS FIRST — without an explicit
        // `nulls: 'last'`, every unscored (severityScore: null) KPI rollup
        // sorted ahead of the real, non-null scores, so `take: 10` could
        // fill the "Top KPIs" table with nulls (shown as 0) and push actual
        // results off the list entirely.
        orderBy: { severityScore: { sort: 'desc', nulls: 'last' } },
        take: 10,
      });

      const priorityAssessment = await tx.villagePriorityAssessment.findFirst({
        where: {
          studyId,
          surveyId,
          methodologyVersionId: mv.id,
          // Unique per villageId too (see its @@unique) — unfiltered, findFirst
          // returned an arbitrary village's assessment rather than the
          // consolidated one, so the headline Priority Score could belong to a
          // single village while the report claimed to cover them all.
          villageId: rollupVillageId,
        },
      });

      // Evidence is scoped to the Survey's own Need, not the whole Study. Each
      // Need under a Study runs an independent workflow with its own documents
      // (see the Need model comment), so a study-wide filter put a sibling
      // Need's files into this survey's report. The aggregate scopes
      // (SECTOR/REGION/EXECUTIVE) legitimately span the study, so they keep the
      // wider set.
      const evidenceScope = SURVEY_LEVEL_SCOPES.includes(scope)
        ? { needId: survey.needId }
        : { studyId };
      // RPT01 declares sourceBasis SURVEY_ONLY and prints "derived from survey
      // responses, no document evidence" on its first page. Handing the model
      // document evidence for that scope let the narrative cite a source the
      // report says it does not use — so INDIVIDUAL gets none. Every other
      // scope, RPT15 included, is not survey-only and keeps its evidence.
      const evidenceRows =
        scope === 'INDIVIDUAL'
          ? []
          : await tx.evidence.findMany({
              where: {
                ...evidenceScope,
                reviewStatus: 'APPROVED',
                isIncludedInReport: true,
              },
            });

      const submittedResponseCount = responses.length;
      const validResponseCount = overallRollup?.validResponseCount ?? submittedResponseCount;
      const dontKnowRate = overallRollup ? Number(overallRollup.dontKnowRate) : 0;
      const confidenceLevel = overallRollup?.confidenceLevel ?? 'STANDARD';

      // `!= null`, not truthiness: a genuine severity of 0.00 is a real, and
      // very good, result — the truthiness check turned it into "not measured".
      const overallNeedsIndex =
        overallRollup?.severityScore != null ? Number(overallRollup.severityScore) : null;
      const severityBand = overallNeedsIndex === null ? 'UNSCORED' : overallNeedsIndex >= 70 ? 'CRITICAL' : overallNeedsIndex >= 50 ? 'HIGH' : overallNeedsIndex >= 30 ? 'MEDIUM' : 'LOW';

      const domainComponents =
        (priorityAssessment?.domainComponents as unknown as DomainPriorityComponent[] | null) || [];

      const snapshot: ReportDataSnapshot = {
        // Deterministic id assigned below, once the content hashes exist — a
        // wall-clock id meant two snapshots of identical data looked different,
        // so nothing downstream could tell "regenerated, same numbers" apart
        // from "regenerated, numbers moved".
        snapshotId: '',
        generatedAt: new Date().toISOString(),
        scope,
        scopeFilters,
        study: {
          studyId,
          studyName: study.title,
          surveyId,
          villageId: villageId || 'ALL_VILLAGES',
          // Consolidated (no single village) scope label aligns with the agreed
          // Region → Governorate hierarchy: "Consolidated Governorates" rather
          // than "Villages". A specific villageId keeps its own identity.
          villageName: villageId || 'Consolidated Governorates',
          assessmentCycle: study.cycleNumber,
          organizationName: study.org.name,
          methodologyVersionId: mv.id,
          methodologyVersionLabel: mv.version,
          // For a survey-scoped report these are the NEED's governorates, not
          // the whole study's. Handing the study's wider list to Gemini is how
          // the narrative came to name "Abha, Ahad Rufaydah" while the header
          // beside it named only Abha. Aggregate scopes keep the study's list.
          governorateName: unitGeo ? unitGeo.governorateNames.join(', ') || null : governorateName,
          regionName: unitGeo ? unitGeo.regionName : regionName,
          population: study.population,
          requiredSampleSize: study.requiredSampleSize,
          minimumDetectableEffect: study.minimumDetectableEffect,
        },
        responseQuality: {
          submittedResponseCount,
          validResponseCount,
          dontKnowRate,
          confidenceLevel,
          // Was a fixed string asserting a high don't-know rate whenever
          // confidence was LOW — but LOW usually fires on sample size. The
          // snapshot handed that false premise to Gemini, which combined it
          // with the real 3.13% and produced a self-contradicting sentence.
          // Fixing the prompt could not have helped: the premise was wrong
          // before the prompt saw it.
          confidenceReason: composeConfidenceReason({
            validResponseCount,
            dontKnowRate,
            thresholds: DEFAULT_THRESHOLDS,
            requiredSampleSize: study.requiredSampleSize,
          }),
          dontKnowBand: dontKnowBandOf(dontKnowRate),
        },
        severity: {
          overallVillageNeedsIndex: overallNeedsIndex,
          severityBand,
          domainSeverityScores: domainRollups.map((d) => ({
            // NORMALIZED. ScoreRollup stores the domain NAME in entityId, while
            // VillagePriorityAssessment.domainComponents stores the normalized
            // key ("LIVELIHOOD"). Publishing the raw name here meant the two
            // never joined: the Domains table showed Confidence STANDARD over a
            // set of indicators that were all LOW, and a KPI count of 0.
            domainKey: normalizeDomainKey(d.entityId),
            domainName: d.entityNameSnapshot,
            // `!= null`, not truthiness — see overallNeedsIndex above.
            severityScore: d.severityScore != null ? Number(d.severityScore) : null,
            confidenceLevel: d.confidenceLevel,
            validResponseCount: d.validResponseCount,
            excludedResponseCount: d.excludedResponseCount,
            dontKnowRate: Number(d.dontKnowRate),
            kpiCount: kpiCountByDomainKey.get(normalizeDomainKey(d.entityId))?.size ?? 0,
          })),
          topKpis: kpiRollups.map((k, index) => ({
            rank: index + 1,
            kpiName: k.entityNameSnapshot,
            // Join semantics live in resolveKpiDomain (pure, unit-tested) —
            // see its comment for why the join is by KPI name, not id.
            ...resolveKpiDomain(k, domainByKpi, indicatorByKpi),
            severityScore: k.severityScore != null ? Number(k.severityScore) : null,
            confidenceLevel: k.confidenceLevel,
            validResponseCount: k.validResponseCount,
          })),
          subDomainSeverityScores: subDomainRollups.map(toRollupLevelRow),
          indicatorSeverityScores: indicatorRollups.map(toRollupLevelRow),
          kpiSeverityScores: allKpiRollups.map((k) => ({
            ...toRollupLevelRow(k),
            excludedResponseCount: k.excludedResponseCount,
            dontKnowCount: k.dontKnowCount,
            notApplicableCount: k.notApplicableCount,
          })),
        },
        priority: {
          // No assessment → null, never 0. A 0 priority score banded as 'LOW'
          // said the opposite of the truth twice over: the banding is
          // ≤ 40 → HIGH, and no score at all is not a low-urgency finding.
          villagePriorityScore: priorityAssessment ? Number(priorityAssessment.priorityScore) : null,
          priorityStatus:
            (priorityAssessment?.priorityStatus as 'HIGH' | 'MEDIUM' | 'LOW' | undefined) ?? null,
          domainPerformanceScores: domainComponents.map((dc) => ({
            domainKey: dc.domainKey,
            domainName: dc.domainNameSnapshot,
            severityScore: dc.domainSeverityScore,
            performanceScore: dc.domainPerformanceScore,
            weight: dc.domainWeight,
            weightedContribution: dc.weightedContribution,
            isCriticalDomain: dc.isCriticalDomain,
            triggeredOverride: dc.triggeredOverride,
          })),
          overrideApplied: priorityAssessment?.overrideApplied ?? false,
          overrideReason: priorityAssessment?.overrideReason ?? null,
          calculatedAt: priorityAssessment?.calculatedAt?.toISOString() ?? new Date().toISOString(),
        },
        questionsAskedByDomain: [...askedByDomainKey.entries()]
          .map(([domainKey, v]) => ({ domain: v.domain, domainKey, count: v.count }))
          .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain)),
        unitGeo,
        evidence: evidenceRows.map((e) => ({
          id: e.id,
          evidenceTitle: e.title || e.fileName,
          type: e.fileType,
          sourceReferenceId: e.sourceReferenceId || e.id.slice(0, 8),
          linkedDomainOrKpi: e.linkedDomainOrKpi || 'General Community Evidence',
          description: e.description || 'Approved community field evidence.',
          collectedDate: e.collectedAt?.toISOString() || e.uploadedAt.toISOString(),
        })),
      };

      // Hashes the DESCRIPTIVE facts too (study identity, geography, response
      // quality), not just the scores. A narrative is written against all of
      // them: when the geography was corrected but the hash ignored it, the
      // cached summary kept naming the old governorates beside a corrected
      // header. Any change to what the narrative was told now invalidates it.
      const reportDataHash = createHash('sha256')
        .update(
          JSON.stringify(snapshot.study) +
            JSON.stringify(snapshot.unitGeo) +
            JSON.stringify(snapshot.responseQuality) +
            JSON.stringify(snapshot.severity) +
            JSON.stringify(snapshot.priority),
        )
        .digest('hex');
      const evidenceHash = createHash('sha256').update(JSON.stringify(snapshot.evidence)).digest('hex');

      // Identity + content, so the same survey scored the same way always
      // yields the same snapshotId. Truncated to 16 hex chars — enough to be
      // collision-free at pilot volume and short enough to print in a report.
      snapshot.snapshotId = `snap-${createHash('sha256')
        .update([studyId, surveyId, scope, JSON.stringify(scopeFilters), reportDataHash, evidenceHash].join('|'))
        .digest('hex')
        .slice(0, 16)}`;

      return { snapshot, reportDataHash, evidenceHash };
    });
  }

  /**
   * Preview included data before calling Gemini.
   */
  async previewSnapshot(
    studyId: string,
    surveyId: string,
    scope: SummaryScopeType = 'VILLAGE',
    scopeFilters: ScopeFilters = {},
  ) {
    return this.buildReportDataSnapshot(studyId, surveyId, scope, scopeFilters);
  }

  /**
   * Generate AI Priority Summary narrative using Gemini with scope-specific prompt.
   */
  async generatePrioritySummary(
    studyId: string,
    surveyId: string,
    scope: SummaryScopeType = 'VILLAGE',
    scopeFilters: ScopeFilters = {},
    /** Extra JSON the scope's prompt is written against — see `extra` below. */
    aiContext?: Record<string, unknown>,
  ) {
    const orgId = requireOrgId();
    const store = getOrgStore();
    const actorId = store?.actorId || '019f8dec-4f72-701c-b1a1-c1577e5dac7a';
    const villageId = scopeFilters.villageId || '';

    const { snapshot, reportDataHash, evidenceHash } = await this.buildReportDataSnapshot(
      studyId,
      surveyId,
      scope,
      scopeFilters,
    );

    // Severity is the gate, not priority. A survey can be fully scored while no
    // VillagePriorityAssessment exists (priority scoring not run, or no domain
    // weights configured) — that is a "not calculable" priority section, not a
    // reason to refuse the whole narrative. The old check only passed because
    // an absent assessment was coerced to 0.
    if (
      snapshot.responseQuality.submittedResponseCount === 0 ||
      snapshot.severity.overallVillageNeedsIndex === null
    ) {
      throw new BadRequestException(
        `Cannot generate AI Summary: No valid survey responses or scoring data available for the selected village/scope (${snapshot.study.villageName}). Please collect survey responses and calculate priority scores first.`,
      );
    }

    const { promptVersion, systemPrompt, responseSchema } = this.getPromptForScope(scope);
    const promptHash = createHash('sha256').update(systemPrompt).digest('hex');

    // Survey-scoped scopes get the extra context their prompts are written
    // against (coverage counts, and for COMBINED the org portfolio/dashboard/
    // comparison). Passed through by the caller rather than re-queried here, so
    // the narrative can only ever describe the same numbers the report renders.
    const extra = aiContext ? `\n\nAdditional context JSON:\n${JSON.stringify(aiContext, null, 2)}\n` : '';
    const promptText = `Generate the ${scope} SUMMARY narrative strictly using this ReportData JSON:
${JSON.stringify(snapshot, null, 2)}
${extra}`;

    // main's per-scope prompt data, wrapped as an AiTask so it goes through the
    // task-based AiService.run this branch uses (retries, timeout, schema
    // enforcement) instead of the removed generateJson.
    const task: AiTask<Record<string, unknown>> = {
      name: `report-summary:${scope}`,
      promptVersion,
      systemPrompt,
      responseSchema,
      model: 'gemini-2.5-flash',
      modelVersion: 'v1',
      temperature: 0.2,
      timeoutMs: 90_000,
      maxRetries: 1,
    };

    const { response: aiOutputJson } = await this.aiService.run(task, promptText);

    return this.tenant.runInOrgContext(async (tx) => {
      await tx.aiPrioritySummary.updateMany({
        where: {
          orgId,
          studyId,
          surveyId,
          villageId: villageId || '',
          summaryScope: scope,
          status: { in: ['DRAFT', 'STALE'] },
        },
        data: { status: 'SUPERSEDED' },
      });

      const summary = await tx.aiPrioritySummary.create({
        data: {
          orgId,
          studyId,
          surveyId,
          villageId: villageId || '',
          reportDataSnapshotId: snapshot.snapshotId,
          status: 'DRAFT',
          summaryScope: scope,
          scopeFilters: scopeFilters as Prisma.InputJsonValue,
          promptVersion,
          promptHash,
          modelName: task.model,
          modelVersion: task.modelVersion,
          inputReportDataHash: reportDataHash,
          inputEvidenceSnapshotHash: evidenceHash,
          aiOutputJson: aiOutputJson as Prisma.InputJsonValue,
          generatedBy: actorId,
        },
      });

      return {
        summary,
        snapshot,
      };
    });
  }

  /**
   * Fetch current active priority summary for scope.
   */
  async getSummary(
    studyId: string,
    surveyId: string,
    scope: SummaryScopeType = 'VILLAGE',
    villageId: string = '',
  ) {
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext(async (tx) => {
      const summary = await tx.aiPrioritySummary.findFirst({
        where: {
          orgId,
          studyId,
          surveyId,
          villageId: villageId || '',
          summaryScope: scope,
          status: { in: ['SAVED', 'OFFICER_CONFIRMED', 'DRAFT', 'STALE'] },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!summary) return null;

      const filters = (summary.scopeFilters as ScopeFilters) || { villageId };
      const snapshotData = await this.buildReportDataSnapshot(studyId, surveyId, scope, filters);
      return {
        summary,
        snapshot: snapshotData.snapshot,
      };
    });
  }

  /**
   * Save Research Officer edits to summary draft.
   */
  async saveDraftEdits(summaryId: string, editedOutputJson: Record<string, unknown>) {
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext(async (tx) => {
      const existing = await tx.aiPrioritySummary.findFirst({
        where: { id: summaryId, orgId },
      });
      if (!existing) throw new NotFoundException('Summary not found');

      return tx.aiPrioritySummary.update({
        where: { id: summaryId },
        data: {
          officerEditedOutputJson: editedOutputJson as Prisma.InputJsonValue,
          updatedAt: new Date(),
        },
      });
    });
  }

  /**
   * Confirm AI Priority Summary.
   */
  async confirmSummary(summaryId: string) {
    const orgId = requireOrgId();
    const store = getOrgStore();
    const actorId = store?.actorId || '019f8dec-4f72-701c-b1a1-c1577e5dac7a';

    return this.tenant.runInOrgContext(async (tx) => {
      const existing = await tx.aiPrioritySummary.findFirst({
        where: { id: summaryId, orgId },
      });
      if (!existing) throw new NotFoundException('Summary not found');

      return tx.aiPrioritySummary.update({
        where: { id: summaryId },
        data: {
          status: 'OFFICER_CONFIRMED',
          officerConfirmedBy: actorId,
          officerConfirmedAt: new Date(),
        },
      });
    });
  }

  /**
   * List historical summary drafts for audit.
   */
  async getSummaryHistory(studyId: string, surveyId: string, scope: SummaryScopeType = 'VILLAGE') {
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext((tx) =>
      tx.aiPrioritySummary.findMany({
        where: { orgId, studyId, surveyId, summaryScope: scope },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /**
   * Invalidate active summary to STALE when scores or evidence change.
   */
  async invalidateIfStale(studyId: string, surveyId: string) {
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext((tx) =>
      tx.aiPrioritySummary.updateMany({
        where: {
          orgId,
          studyId,
          surveyId,
          status: { in: ['DRAFT', 'OFFICER_CONFIRMED'] },
        },
        data: { status: 'STALE' },
      }),
    );
  }

  /**
   * Toggle evidence inclusion in report.
   */
  async toggleEvidenceInclusion(evidenceId: string, isIncludedInReport: boolean) {
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext(async (tx) => {
      const evidence = await tx.evidence.findFirst({
        where: { id: evidenceId, orgId },
      });
      if (!evidence) throw new NotFoundException('Evidence not found');

      const updated = await tx.evidence.update({
        where: { id: evidenceId },
        data: { isIncludedInReport },
      });

      await tx.aiPrioritySummary.updateMany({
        where: {
          orgId,
          studyId: evidence.studyId,
          status: { in: ['DRAFT', 'OFFICER_CONFIRMED'] },
        },
        data: { status: 'STALE' },
      });

      return updated;
    });
  }

  /**
   * Save confirmed AI Priority Summary into the organization Reports repository.
   */
  // Converges onto the SAME rich content the report generators produce (village/
  // sector/region/executive), so exports and the on-screen viewer render it
  // identically and there is one canonical Report content shape — instead of the
  // old minimal { summaryId, scope, aiOutput } blob.
  async saveReportFromSummary(summaryId: string) {
    const orgId = requireOrgId();
    const store = getOrgStore();
    const generatedBy = store?.actorId || '019f8dec-4f72-701c-b1a1-c1577e5dac7a';

    const summary = await this.tenant.runInOrgContext((tx) =>
      tx.aiPrioritySummary.findFirst({ where: { id: summaryId, orgId } }),
    );
    if (!summary) throw new NotFoundException('Summary not found');
    if (summary.status !== 'OFFICER_CONFIRMED') {
      throw new BadRequestException('Summary must be OFFICER_CONFIRMED before saving to report repository.');
    }

    const scope = (summary.summaryScope as SummaryScopeType) || 'VILLAGE';
    const scopeFilters = (summary.scopeFilters as ScopeFilters) || {};
    const villageId = scopeFilters.villageId || '';

    // Rebuild the real snapshot; reuse the confirmed AI output (officer edits win).
    const { snapshot } = await this.buildReportDataSnapshot(summary.studyId, summary.surveyId, scope, scopeFilters);
    const aiOutput = (summary.officerEditedOutputJson ?? summary.aiOutputJson) as Record<string, unknown> | null;
    // Gender/rural breakdown is real respondent data, independent of which
    // scope this report is — computing it only for VILLAGE and hard-coding
    // null everywhere else meant Sector/Region/Executive reports always
    // showed "Not available" even when matching SurveyResponse rows exist.
    // `villageId` is still whatever the scope's own filters resolved to
    // (empty for SECTOR/EXECUTIVE unless a village sub-filter was picked,
    // which aggregateDemographics already treats as "whole study").
    const demographics = await aggregateDemographics(this.tenant, { studyId: summary.studyId }, villageId);

    // INDIVIDUAL/COMBINED summaries belong to the survey-scoped reports, which
    // are generated through POST /reports (they need coverage/portfolio counts
    // this path doesn't build). Falling through here would have saved them as a
    // Village report — wrong type, wrong content shape.
    if (scope === 'INDIVIDUAL' || scope === 'COMBINED') {
      throw new BadRequestException(
        `${scope} summaries are saved via the Reports screen (POST /reports), not from the Insights page.`,
      );
    }

    const mapperArgs = { snapshot, aiOutput, demographics, filters: scopeFilters as Record<string, unknown> };
    const content =
      scope === 'SECTOR'
        ? snapshotToSectorContent(mapperArgs)
        : scope === 'REGION'
          ? snapshotToRegionContent(mapperArgs)
          : scope === 'EXECUTIVE'
            ? snapshotToExecutiveContent(mapperArgs)
            : snapshotToVillageContent(mapperArgs);

    const reportType = scope === 'SECTOR' ? 'RPT04' : scope === 'REGION' ? 'RPT06' : scope === 'EXECUTIVE' ? 'RPT13' : 'RPT14';
    const title =
      scope === 'VILLAGE'
        ? `Village Report — ${snapshot.study.villageName}`
        : `${scope.charAt(0) + scope.slice(1).toLowerCase()} Report — ${snapshot.study.studyName}`;

    return this.tenant.runInOrgContext((tx) =>
      tx.report.create({
        data: {
          orgId,
          reportType,
          title,
          studyId: summary.studyId,
          // The summary is already survey-scoped (AiPrioritySummary.surveyId);
          // dropping it here was what made two surveys under one study produce
          // two indistinguishable, untraceable report rows.
          surveyId: summary.surveyId,
          filters: scopeFilters as Prisma.InputJsonValue,
          content: content as unknown as Prisma.InputJsonValue,
          generatedBy,
        },
      }),
    );
  }

  /**
   * Save a summary record explicitly into the saved summaries collection for the tenant organization.
   */
  async saveSummary(summaryId: string, editedOutputJson?: Record<string, unknown>) {
    const orgId = requireOrgId();
    const store = getOrgStore();
    const actorId = store?.actorId || '019f8dec-4f72-701c-b1a1-c1577e5dac7a';

    return this.tenant.runInOrgContext(async (tx) => {
      const existing = await tx.aiPrioritySummary.findFirst({
        where: { id: summaryId, orgId },
      });
      if (!existing) throw new NotFoundException('Summary not found');

      return tx.aiPrioritySummary.update({
        where: { id: summaryId },
        data: {
          status: 'SAVED',
          ...(editedOutputJson ? { officerEditedOutputJson: editedOutputJson as Prisma.InputJsonValue } : {}),
          officerConfirmedBy: actorId,
          officerConfirmedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });
  }

  /**
   * Fetch all saved summaries for the organization (multi-tenant isolated).
   */
  async getSavedSummariesList(studyId: string, surveyId: string) {
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext((tx) =>
      tx.aiPrioritySummary.findMany({
        where: {
          orgId,
          studyId,
          surveyId,
          status: { in: ['SAVED', 'OFFICER_CONFIRMED'] },
        },
        orderBy: { updatedAt: 'desc' },
      }),
    );
  }

  /**
   * Delete a saved summary record for the organization.
   */
  async deleteSavedSummary(summaryId: string) {
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext(async (tx) => {
      const existing = await tx.aiPrioritySummary.findFirst({
        where: { id: summaryId, orgId },
      });
      if (!existing) throw new NotFoundException('Summary not found');

      return tx.aiPrioritySummary.delete({
        where: { id: summaryId },
      });
    });
  }
}
