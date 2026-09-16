import { EXCLUDE_MERGED } from '../../needs/need-visibility';
import type { TenantPrismaService } from "../../../tenancy/tenant-prisma.service";
import type { CoverageBlock } from "../report-content.types";

// Survey-level volume/coverage counts — the "how many studies / needs /
// questions / responses / documents does this report actually rest on?" band
// that every survey-scoped report (RPT01, RPT15) opens with.
//
// One batched Promise.all of count/groupBy calls inside a single org-scoped
// transaction (RIO-NFR-005), never a per-entity loop. Every figure is a real
// count — an empty study honestly reports zeros rather than being omitted, so
// the tile band never changes shape between reports.

export interface CoverageQuery {
  studyId: string;
  surveyId: string;
  needId: string;
  /** Optional village filter — mirrors the report's own scopeFilters.villageId. */
  villageId?: string;
  /** From ScoreRollup(OVERALL); the rollup is the authority on valid vs excluded. */
  validResponseCount?: number;
  excludedResponseCount?: number;
  /** Required, not defaulted: an absent rate is unknown, and defaulting it to 0
   *  would claim nobody answered "don't know". The rollup is the authority. */
  dontKnowRatePct: number;
  /** Human-readable collection window, e.g. "01 July 2026 - 15 July 2026". */
  assessmentPeriod?: string;
}

// Formats the min/max SurveyResponse.submittedAt window the same way
// ReportsService.formatAssessmentPeriod does, so the two never disagree.
function formatPeriod(min: Date | null, max: Date | null): string | null {
  if (!min || !max) return null;
  const fmt = (d: Date) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
  const from = fmt(min);
  const to = fmt(max);
  return from === to ? from : `${from} - ${to}`;
}

export async function buildCoverageBlock(
  tenant: TenantPrismaService,
  query: CoverageQuery,
): Promise<CoverageBlock> {
  const { studyId, surveyId, needId, villageId } = query;

  return tenant.runInOrgContext(async (tx) => {
    const [
      study,
      need,
      needsInStudy,
      surveysInStudy,
      questionRows,
      links,
      activeLinks,
      responsesSubmitted,
      responseWindow,
      quality,
      evidenceTotal,
      evidenceIncluded,
      governorates,
      centers,
      domainRollups,
      kpiRollups,
      kpiRollupsWithScore,
    ] = await Promise.all([
      tx.study.findUnique({ where: { id: studyId }, select: { title: true, cycleNumber: true, villages: true } }),
      tx.need.findUnique({ where: { id: needId }, select: { village: true } }),
      tx.need.count({ where: { studyId, ...EXCLUDE_MERGED } }),
      tx.survey.count({ where: { studyId } }),
      // Bank vs custom questions: a SurveyQuestion row is a Question Bank entry
      // when questionId is set, and a study-specific "additional" question when
      // customText is set instead (see the SurveyQuestion model comment).
      tx.surveyQuestion.findMany({ where: { surveyId }, select: { questionId: true } }),
      tx.publicSurveyLink.count({ where: { needId } }),
      tx.publicSurveyLink.count({ where: { needId, isActive: true } }),
      tx.surveyResponse.count({ where: { needId } }),
      tx.surveyResponse.aggregate({
        where: { needId },
        _min: { submittedAt: true },
        _max: { submittedAt: true },
      }),
      tx.responseQualityResult.findMany({
        where: { needId },
        select: { confidenceFlag: true, isDuplicate: true },
      }),
      tx.evidence.count({ where: { needId } }),
      tx.evidence.count({ where: { needId, isIncludedInReport: true } }),
      tx.needGovernorate.count({ where: { needId } }),
      tx.needCenter.count({ where: { needId } }),
      // ScoreRollup stores the consolidated scope as villageId '' (Prisma can't
      // put null in a unique constraint) AND one row per village. Omitting the
      // filter counted both, so 2 domains reported as 4 and 9 KPIs as 18 — the
      // tiles then contradicted the table directly beneath them. Same convention
      // as report-summary.service.ts's `rollupVillageId`: always filter, using
      // '' for consolidated.
      tx.scoreRollup.count({
        where: { studyId, surveyId, rollupLevel: "DOMAIN", villageId: villageId || "" },
      }),
      tx.scoreRollup.count({
        where: { studyId, surveyId, rollupLevel: "KPI", villageId: villageId || "" },
      }),
      // Attempted vs actually scored: a KPI rollup exists for every KPI the
      // survey asked about, but severityScore is null when nothing could be
      // scored. The tile reads "8 scored · 1 not measurable" instead of
      // silently counting the unmeasurable one as a result.
      tx.scoreRollup.count({
        where: {
          studyId,
          surveyId,
          rollupLevel: "KPI",
          villageId: villageId || "",
          severityScore: { not: null },
        },
      }),
    ]);

    const fromBank = questionRows.filter((q) => q.questionId !== null).length;
    // Villages this survey actually covers: the Need's own list, falling back to
    // the Study's when the Need has none (a Need may inherit the study scope).
    const villages = (need?.village?.length ? need.village : (study?.villages ?? [])).filter(Boolean);

    const submitted = responsesSubmitted;
    const valid = query.validResponseCount ?? submitted;
    const excluded = query.excludedResponseCount ?? Math.max(0, submitted - valid);

    return {
      studyTitle: study?.title ?? "—",
      studyCycleNumber: study?.cycleNumber ?? 0,
      needsInStudy,
      // A Survey belongs to exactly one Need (Survey.needId), so this survey
      // covers 1 of `needsInStudy` — rendered as "1 of N" rather than a bare 1.
      needsCoveredByThisSurvey: 1,
      surveysInStudy,
      villagesCovered: villages.length,
      villageNames: villages,
      governoratesCovered: governorates,
      centersCovered: centers,
      surveyQuestionsTotal: questionRows.length,
      surveyQuestionsFromBank: fromBank,
      surveyQuestionsCustom: questionRows.length - fromBank,
      publicSurveyLinks: links,
      activeSurveyLinks: activeLinks,
      responsesSubmitted: submitted,
      responsesValid: valid,
      responsesExcluded: excluded,
      dontKnowRatePct: query.dontKnowRatePct,
      duplicateResponses: quality.filter((q) => q.isDuplicate).length,
      lowConfidenceResponses: quality.filter((q) => q.confidenceFlag === "low").length,
      evidenceFilesTotal: evidenceTotal,
      evidenceIncludedInReport: evidenceIncluded,
      domainsScored: domainRollups,
      kpisAttempted: kpiRollups,
      kpisScored: kpiRollupsWithScore,
      kpisNotMeasurable: kpiRollups - kpiRollupsWithScore,
      assessmentPeriod:
        query.assessmentPeriod ??
        formatPeriod(responseWindow._min.submittedAt, responseWindow._max.submittedAt) ??
        "No responses collected yet",
    };
  });
}
