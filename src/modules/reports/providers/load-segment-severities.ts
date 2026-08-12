import type { TenantPrismaService } from "../../../tenancy/tenant-prisma.service";
import type { EquityDimension } from "../need-record.types";
import type { SegmentRow } from "./derive-equity-flag";

// Per-KPI severity broken down by respondent segment — the input the equity flag
// needs ("variance across groups").
//
// Computed here from the same ResponseSeverityScore rows the rollup pipeline
// consumes, so a segment mean can never disagree with the KPI mean it sits under.
//
// Placement note: the target design persists these as ScoreRollupSegment rows
// written by RollupService, so the Merged and NCNP reports read the SAME value
// rather than each deriving it. That needs a migration; until it lands this
// derives the identical figure from the identical source at report time. The
// arithmetic is the rollup's own (mean of SCORED rows, n = count of them), which
// is what makes the two interchangeable.
//
// Dimensions available today: gender, settlement_type, village. There is no age
// band and no disability status on SurveyResponse — adding either is a citizen-
// form change, not a report change.

interface SegmentCell {
  dimension: EquityDimension;
  value: string;
  sum: number;
  n: number;
}

export async function loadSegmentSeverities(
  tenant: TenantPrismaService,
  query: { studyId: string; surveyId: string; methodologyVersionId: string; villageId?: string },
): Promise<Map<string, SegmentRow[]>> {
  const { studyId, surveyId, methodologyVersionId, villageId } = query;

  return tenant.runInOrgContext(async (tx) => {
    const [scores, questions] = await Promise.all([
      tx.responseSeverityScore.findMany({
        where: {
          studyId,
          surveyId,
          methodologyVersionId,
          // Only SCORED rows carry a severity; excluded / not-applicable rows have
          // nothing to average and must not count towards a group's n either.
          scoreStatus: "SCORED",
          severityScore: { not: null },
        },
        select: {
          questionId: true,
          severityScore: true,
          surveyResponse: { select: { gender: true, settlementType: true, village: true } },
        },
      }),
      // Version-scoped (RIO-AI-005) — the questionId -> KPI map below is
      // first-wins, so another imported bank's row could shadow this version's
      // and attribute a severity score to the wrong KPI.
      tx.question.findMany({
        where: { methodologyVersionId, usedInMvp: true, kpi: { not: null } },
        select: { questionId: true, kpi: true },
      }),
    ]);

    const kpiByQuestion = new Map(questions.map((q) => [q.questionId, q.kpi as string]));

    // kpi → "dimension|value" → running mean. The cell carries its own dimension
    // and value so nothing has to parse the composite key back apart (village
    // names contain separators of every kind).
    const acc = new Map<string, Map<string, SegmentCell>>();
    const add = (kpi: string, dimension: EquityDimension, value: string, severity: number) => {
      const key = `${dimension}|${value}`;
      const byKey = acc.get(kpi) ?? new Map<string, SegmentCell>();
      acc.set(kpi, byKey);
      const cell = byKey.get(key) ?? { dimension, value, sum: 0, n: 0 };
      cell.sum += severity;
      cell.n += 1;
      byKey.set(key, cell);
    };

    for (const s of scores) {
      const kpi = kpiByQuestion.get(s.questionId);
      if (!kpi) continue;
      const severity = Number(s.severityScore);
      const r = s.surveyResponse;
      if (r.gender) add(kpi, "gender", String(r.gender), severity);
      if (r.settlementType) add(kpi, "settlement_type", String(r.settlementType), severity);
      // A response may cover several villages; each is a legitimate member of
      // that village's group.
      for (const v of r.village ?? []) {
        if (!v) continue;
        if (villageId && v !== villageId) continue;
        add(kpi, "village", v, severity);
      }
    }

    const out = new Map<string, SegmentRow[]>();
    for (const [kpi, byKey] of acc) {
      out.set(
        kpi,
        [...byKey.values()].map((cell) => ({
          dimension: cell.dimension,
          value: cell.value,
          severityScore: cell.n > 0 ? cell.sum / cell.n : null,
          validResponseCount: cell.n,
        })),
      );
    }
    return out;
  });
}
