import { Injectable } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { MethodologyConfigService } from "../methodology-config/methodology-config.service";
import { EXCLUDE_MERGED } from "../needs/need-visibility";
import { isCrossOrgReader } from "./cross-org-reader";

/**
 * UAT DQ-05 — survey responses as a first-class part of Data Quality: one row
 * per published survey with its responses' completeness, anomalies and
 * confidence flag, next to the need-record findings the page already showed.
 *
 * Read-only. Every number comes from data that already exists:
 * - completeness: share of each response's required questions answered;
 * - anomalies: pending cleaning findings on those responses, and responses
 *   the response-quality check marked as possible duplicates;
 * - confidence: the scoring roll-up's own LOW / STANDARD flag when the survey
 *   has been scored; before that, the same respondent-count rule the roll-up
 *   applies (fewer than the configured minimum, or below the study's required
 *   sample, is LOW), with the "Don't know" share left blank until scoring.
 */
export interface SurveyQualityRow {
  surveyId: string;
  needId: string;
  needReferenceId: string;
  needTitle: string;
  studyId: string;
  studyTitle: string;
  responseCount: number;
  excludedCount: number;
  /** 0–100, averaged over the counted responses; null with no responses. */
  completenessPct: number | null;
  /** Pending cleaning findings on this survey's responses. */
  openFindings: number;
  /** Responses the response-quality check marked as possible duplicates. */
  possibleDuplicates: number;
  /** 0–100 from the scoring roll-up; null until the survey is scored. */
  dontKnowPct: number | null;
  confidence: "LOW" | "STANDARD";
  /** Why the confidence is LOW, for the tooltip. */
  confidenceReasons: ("few_respondents" | "below_required_sample" | "high_dont_know")[];
  scored: boolean;
}

/** Same format as NeedsService's internal reference ("NEED-000042"). Not
 * imported from there: needs.service already imports this module. */
const needReference = (seq: number): string => `NEED-${String(seq).padStart(6, "0")}`;

const isAnswered = (value: unknown): boolean =>
  value !== null &&
  value !== undefined &&
  !(typeof value === "string" && value.trim() === "") &&
  !(Array.isArray(value) && value.length === 0);

@Injectable()
export class SurveyQualityService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly methodologyConfig: MethodologyConfigService,
  ) {}

  async list(studyId?: string): Promise<SurveyQualityRow[]> {
    const { confidenceFlagSettings } = await this.methodologyConfig.getRaw();
    const minRespondents = Number(confidenceFlagSettings.minRespondentsForStandardConfidence);
    const dontKnowLimit = Number(confidenceFlagSettings.dontKnowRatioThreshold);

    const read = async (tx: Prisma.TransactionClient): Promise<SurveyQualityRow[]> => {
      // The live survey of each need: published, latest version first.
      const surveys = await tx.survey.findMany({
        where: {
          status: "PUBLISHED",
          ...(studyId ? { studyId } : {}),
          need: EXCLUDE_MERGED,
        },
        orderBy: [{ needId: "asc" }, { version: "desc" }],
        select: {
          id: true,
          needId: true,
          studyId: true,
          surveyQuestions: { select: { id: true, isRequired: true } },
          need: { select: { internalRefSeq: true, title: true } },
          study: { select: { title: true, requiredSampleSize: true } },
        },
      });
      const latest = new Map<string, (typeof surveys)[number]>();
      for (const s of surveys) if (!latest.has(s.needId)) latest.set(s.needId, s);
      const live = [...latest.values()];
      if (live.length === 0) return [];

      const needIds = live.map((s) => s.needId);
      const surveyIds = live.map((s) => s.id);
      // Every version of each need's survey: a response is measured against
      // the version it was answered on, not just the latest one.
      const versions = await tx.survey.findMany({
        where: { needId: { in: needIds } },
        select: { needId: true, surveyQuestions: { select: { id: true, isRequired: true } } },
      });
      const [responses, rollups] = await Promise.all([
        tx.surveyResponse.findMany({
          where: { needId: { in: needIds } },
          select: { id: true, needId: true, answers: true, exclusionReason: true },
        }),
        tx.scoreRollup.findMany({
          where: { surveyId: { in: surveyIds }, rollupLevel: "OVERALL", villageId: null },
          orderBy: { calculatedAt: "desc" },
          select: { surveyId: true, dontKnowRate: true, confidenceLevel: true },
        }),
      ]);
      const responseIds = responses.map((r) => r.id);
      const [flags, duplicates] = responseIds.length
        ? await Promise.all([
            tx.cleaningFlag.groupBy({
              by: ["entityId"],
              where: { entityType: "survey_response", status: "pending", entityId: { in: responseIds } },
              _count: { _all: true },
            }),
            tx.responseQualityResult.findMany({
              where: { surveyResponseId: { in: responseIds }, isDuplicate: true },
              distinct: ["surveyResponseId"],
              select: { surveyResponseId: true },
            }),
          ])
        : [[], []];

      const flagsByResponse = new Map(flags.map((f) => [f.entityId, f._count._all]));
      const duplicateIds = new Set(duplicates.map((d) => d.surveyResponseId));
      const rollupBySurvey = new Map<string, (typeof rollups)[number]>();
      for (const r of rollups) if (!rollupBySurvey.has(r.surveyId)) rollupBySurvey.set(r.surveyId, r);

      return live.map((survey) => {
        const own = responses.filter((r) => r.needId === survey.needId);
        const counted = own.filter((r) => !r.exclusionReason);
        const needVersions = versions.filter((v) => v.needId === survey.needId);
        const questionsFor = (answers: Record<string, unknown>) => {
          // The version whose questions the answers are keyed to.
          let best = survey.surveyQuestions;
          let bestHits = -1;
          for (const v of needVersions) {
            const hits = v.surveyQuestions.filter((q) => q.id in answers).length;
            if (hits > bestHits) {
              best = v.surveyQuestions;
              bestHits = hits;
            }
          }
          const required = best.filter((q) => q.isRequired);
          return required.length > 0 ? required : best;
        };

        const ratios = counted
          .map((r) => {
            const answers = (r.answers ?? {}) as Record<string, unknown>;
            const questions = questionsFor(answers);
            return questions.length === 0
              ? null
              : questions.filter((q) => isAnswered(answers[q.id])).length / questions.length;
          })
          .filter((ratio): ratio is number => ratio !== null);
        const completenessPct =
          ratios.length === 0
            ? null
            : Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100);

        const rollup = rollupBySurvey.get(survey.id);
        const dontKnowRate = rollup ? Number(rollup.dontKnowRate) : null;
        const requiredSample = survey.study.requiredSampleSize;
        const reasons: SurveyQualityRow["confidenceReasons"] = [];
        if (counted.length < minRespondents) reasons.push("few_respondents");
        if (requiredSample != null && counted.length < requiredSample) {
          reasons.push("below_required_sample");
        }
        if (dontKnowRate !== null && dontKnowRate > dontKnowLimit) reasons.push("high_dont_know");
        const confidence: "LOW" | "STANDARD" =
          rollup?.confidenceLevel === "LOW" || reasons.length > 0 ? "LOW" : "STANDARD";

        return {
          surveyId: survey.id,
          needId: survey.needId,
          needReferenceId: needReference(survey.need.internalRefSeq),
          needTitle: survey.need.title,
          studyId: survey.studyId,
          studyTitle: survey.study.title,
          responseCount: counted.length,
          excludedCount: own.length - counted.length,
          completenessPct,
          openFindings: own.reduce((sum, r) => sum + (flagsByResponse.get(r.id) ?? 0), 0),
          possibleDuplicates: own.filter((r) => duplicateIds.has(r.id)).length,
          dontKnowPct: dontKnowRate === null ? null : Math.round(dontKnowRate * 100),
          confidence,
          confidenceReasons: reasons,
          scored: rollup !== undefined,
        };
      });
    };

    return isCrossOrgReader()
      ? this.tenant.runAsSupervisor(read)
      : this.tenant.runInOrgContext(read);
  }
}
