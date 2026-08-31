import { Injectable, Logger } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { Prisma, type Question } from '../../generated/prisma';
import { DeterministicScoringService, type ParsedAnswer } from './scoring.service';
import { PriorityV2Service } from './priority-v2.service';
import { MethodologyConfigService } from '../methodology-config/methodology-config.service';
import type { ConfidenceFlagSettings } from '../methodology-config/methodology-config.types';

// Shared shape for the KPI/Indicator/Sub-Domain/Domain rollup maps below —
// each level aggregates its children into exactly this, one level at a time
// (KPI -> Indicator -> Sub-Domain -> Domain).
interface RollupAggregate {
  severityScore: number | null;
  confidenceLevel: 'LOW' | 'STANDARD';
  validResponseCount: number;
  dontKnowRate: number;
}

@Injectable()
export class ScoreRollupService {
  private readonly logger = new Logger(ScoreRollupService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly scoringEngine: DeterministicScoringService,
    private readonly priorityV2: PriorityV2Service,
    private readonly methodologyConfig: MethodologyConfigService,
  ) {}

  /**
   * RIO-FR-024 dual confidence criterion (Sample Size Reference sheet,
   * signed off by Dr. Zulfiqar): LOW if below the absolute floor (System
   * Admin-configurable via Methodology Configuration — see
   * MethodologyConfig.confidenceFlagSettings, RIO-NFR-017) OR below the
   * study's own population-based required sample (Cochran + finite
   * population correction, computed once at study creation — see
   * StudiesService/sample-size.ts). `requiredSampleSize` is null for
   * studies created before this field existed, in which case only the
   * absolute floor and the don't-know rate apply.
   *
   * Previously hardcoded to 10 / 0.20 here — silently diverging from
   * whatever a System Admin actually configured on the Config screen,
   * since nothing re-read this method against a config change (RIO-NFR-017
   * fix, 2026-08-23).
   */
  private isLowConfidence(
    validCount: number,
    dontKnowRate: number,
    requiredSampleSize: number | null,
    settings: ConfidenceFlagSettings,
  ): boolean {
    return (
      validCount < settings.minRespondentsForStandardConfidence ||
      (requiredSampleSize != null && validCount < requiredSampleSize) ||
      dontKnowRate > settings.dontKnowRatioThreshold
    );
  }

  /**
   * Run a complete recalculation for all responses under a given study/survey.
   */
  async recalculateStudyScores(studyId: string, surveyId: string): Promise<void> {
    await this.tenant.runInOrgContext(async (tx) => {
      // Find the survey first — responses are scoped to *its* Need, not the
      // whole study. A study can hold many Needs, each with its own
      // independent survey; scoping by studyId alone pulled in unrelated
      // Needs' responses and mis-scored them against this survey's
      // questions.
      const survey = await tx.survey.findUnique({
        where: { id: surveyId },
        include: {
          surveyQuestions: {
            include: { question: true }
          }
        }
      });
      if (!survey) return;

      const responses = await tx.surveyResponse.findMany({
        where: { needId: survey.needId },
        include: { need: true }
      });

      const responseIds = responses.map(r => r.id);
      if (responseIds.length === 0) return;

      // Clear existing answers and scores for these responses
      await tx.responseAnswer.deleteMany({
        where: { surveyResponseId: { in: responseIds } }
      });
      await tx.responseSeverityScore.deleteMany({
        where: { surveyResponseId: { in: responseIds } }
      });

      const mv = await tx.methodologyVersion.findFirst({
        where: survey.methodologyVersion ? { version: survey.methodologyVersion } : { status: 'PUBLISHED' },
        orderBy: { createdAt: 'desc' }
      });
      if (!mv) return;

      const lookups = await tx.scoringLookup.findMany({
        where: { methodologyVersionId: mv.id, isActive: true }
      });

      // Re-run scoring for each response
      for (const r of responses) {
        const rawAnswers = (r.answers || {}) as Record<string, unknown>;

        const answersMap = new Map<string, ParsedAnswer>();
        const questionMappings: Array<{ sqId: string; question: Question; rawAnswer: unknown }> = [];
        for (const sq of survey.surveyQuestions) {
          if (sq.question) {
            const q = sq.question;
            const parsed = this.scoringEngine.parseRawAnswerValue(rawAnswers[sq.id], q.measurementMode);
            answersMap.set(q.questionId, parsed);
            questionMappings.push({ sqId: sq.id, question: q, rawAnswer: rawAnswers[sq.id] });
          }
        }

        const orgId = r.orgId;
        // A Need (and its responses) can name more than one village — every
        // village named gets full credit for this response, not just the
        // first. Previously took only `village?.[0]`, so a second (or
        // third) village on the same Need silently got zero
        // ResponseAnswer/ResponseSeverityScore rows and therefore no
        // rollup or VillagePriorityAssessment at all — it just sat at
        // "not yet scored" forever with no error, even though the
        // response that should have scored it existed. `[null]` preserves
        // the original no-village (study-wide-only) behavior when a Need
        // names none.
        const resolvedVillageIds = r.need.village.length > 0 ? r.need.village : [null];

        for (const resolvedVillageId of resolvedVillageIds) {
        for (const { question, rawAnswer } of questionMappings) {
          const qId = question.questionId;
          // Guaranteed present: questionMappings and answersMap are built from
          // the same survey.surveyQuestions loop above, one entry each per
          // sq.question — every qId reachable here was just .set() there.
          const parsed = answersMap.get(qId)!;

          const answerRecord = await tx.responseAnswer.create({
            data: {
              orgId,
              surveyResponseId: r.id,
              surveyId: survey.id,
              studyId,
              villageId: resolvedVillageId,
              respondentId: r.contact,
              questionId: qId,
              answerOptionId: parsed.optionId,
              answerNumericValue: parsed.numericValue !== null ? new Prisma.Decimal(parsed.numericValue) : null,
              answerText: parsed.text,
              answerOptionIds: parsed.optionIds ? JSON.parse(JSON.stringify(parsed.optionIds)) : null,
              isApplicable: true,
              submittedAt: r.submittedAt,
            }
          });

          const isApplicable = this.scoringEngine.evaluateConditionalRule(question, answersMap);
          if (!isApplicable) {
            await tx.responseAnswer.update({
              where: { id: answerRecord.id },
              data: { isApplicable: false }
            });
            await tx.responseSeverityScore.create({
              data: {
                orgId,
                responseAnswerId: answerRecord.id,
                surveyResponseId: r.id,
                surveyId: survey.id,
                studyId,
                villageId: resolvedVillageId,
                questionId: qId,
                methodologyVersionId: mv.id,
                rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
                severityScore: null,
                scoreStatus: 'NOT_APPLICABLE',
                calculationVersion: 'v1',
              }
            });
            continue;
          }

          if (!question.isScoreable) {
            await tx.responseSeverityScore.create({
              data: {
                orgId,
                responseAnswerId: answerRecord.id,
                surveyResponseId: r.id,
                surveyId: survey.id,
                studyId,
                villageId: resolvedVillageId,
                questionId: qId,
                methodologyVersionId: mv.id,
                rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
                severityScore: null,
                scoreStatus: 'NOT_SCOREABLE',
                calculationVersion: 'v1',
              }
            });
            continue;
          }

          if (parsed.optionId === null && (parsed.optionIds === null || parsed.optionIds.length === 0) && parsed.numericValue === null && parsed.text === null) {
            await tx.responseSeverityScore.create({
              data: {
                orgId,
                responseAnswerId: answerRecord.id,
                surveyResponseId: r.id,
                surveyId: survey.id,
                studyId,
                villageId: resolvedVillageId,
                questionId: qId,
                methodologyVersionId: mv.id,
                rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
                severityScore: null,
                scoreStatus: 'EXCLUDED',
                exclusionReason: 'MISSING_ANSWER',
                calculationVersion: 'v1',
              }
            });
            continue;
          }

          const exclusion = this.scoringEngine.getOptionExclusion(parsed.optionId, lookups, qId);
          if (exclusion) {
            await tx.responseSeverityScore.create({
              data: {
                orgId,
                responseAnswerId: answerRecord.id,
                surveyResponseId: r.id,
                surveyId: survey.id,
                studyId,
                villageId: resolvedVillageId,
                questionId: qId,
                methodologyVersionId: mv.id,
                scoringLookupId: exclusion.lookupId,
                rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
                severityScore: null,
                scoreStatus: 'EXCLUDED',
                exclusionReason: exclusion.exclusionReason,
                calculationVersion: 'v1',
              }
            });
            continue;
          }

          try {
            const scoreResult = this.scoringEngine.calculateSeverity(question, parsed, lookups);
            await tx.responseSeverityScore.create({
              data: {
                orgId,
                responseAnswerId: answerRecord.id,
                surveyResponseId: r.id,
                surveyId: survey.id,
                studyId,
                villageId: resolvedVillageId,
                questionId: qId,
                methodologyVersionId: mv.id,
                scoringLookupId: scoreResult.scoringLookupId,
                rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
                severityScore: scoreResult.score !== null ? new Prisma.Decimal(scoreResult.score) : null,
                scoreStatus: scoreResult.status,
                exclusionReason: scoreResult.exclusionReason,
                calculationVersion: 'v1',
              }
            });
          } catch {
            await tx.responseSeverityScore.create({
              data: {
                orgId,
                responseAnswerId: answerRecord.id,
                surveyResponseId: r.id,
                surveyId: survey.id,
                studyId,
                villageId: resolvedVillageId,
                questionId: qId,
                methodologyVersionId: mv.id,
                rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
                severityScore: null,
                scoreStatus: 'ERROR',
                exclusionReason: 'MISSING_LOOKUP',
                calculationVersion: 'v1',
              }
            });
          }
        }
        }
      }

      // Re-run rollups for all distinct villages and also study-wide.
      // Reuses this same `tx` rather than letting calculateRollups open its
      // own transaction — nesting a second `$transaction` inside this
      // still-open one meant its reads couldn't see the rows just written
      // above (not yet committed), so rollups silently came back empty.
      // Flattened across every village a response's Need names, not just
      // the first (see resolvedVillageIds above) — a second village here
      // previously never got its own rollup computed at all.
      const distinctVillages = Array.from(new Set(responses.flatMap(r => r.need.village))) as string[];
      for (const v of distinctVillages) {
        await this.calculateRollups(studyId, surveyId, v, { tx, orgId: survey.orgId });
      }
      await this.calculateRollups(studyId, surveyId, null, { tx, orgId: survey.orgId });
    });

    // Call priority v2 recalculation
    await this.priorityV2.recalculateAll(studyId, surveyId);
  }

  /**
   * Recalculate all scoring rollups for a given study and survey.
   * Runs for both the specific village (if provided) and study-wide (villageId = null).
   *
   * `options.tx` — reuse an already-open transaction (see
   * recalculateStudyScores above) instead of opening a new one. Required
   * when called from inside another `runInOrgContext`/`runAsOrg` block:
   * Prisma's `$transaction` doesn't nest, and a second one started before
   * the first commits can't see its uncommitted writes.
   * `options.orgId` — explicit org id for callers with no ambient request
   * context (the citizen survey-submission flow is unauthenticated), same
   * reasoning as DeterministicScoringService#scoreResponse.
   */
  async calculateRollups(
    studyId: string,
    surveyId: string,
    villageId: string | null,
    options?: { tx?: Prisma.TransactionClient; orgId?: string },
  ): Promise<void> {
    // Fetched once per call, outside the tx — MethodologyConfig is global
    // reference data (no orgId/RLS), not part of this run's tenant-scoped
    // transaction.
    const { confidenceFlagSettings } = await this.methodologyConfig.getRaw();
    const body = async (tx: Prisma.TransactionClient) => {
      // Find methodology version used by the survey
      const survey = await tx.survey.findUnique({
        where: { id: surveyId }
      });
      if (!survey) return;

      const methodologyVersion = await tx.methodologyVersion.findFirst({
        where: survey.methodologyVersion ? { version: survey.methodologyVersion } : { status: 'PUBLISHED' },
        orderBy: { createdAt: 'desc' }
      });
      if (!methodologyVersion) return;

      const methodologyVersionId = methodologyVersion.id;

      // RIO-FR-024 dual confidence criterion: see isLowConfidence below.
      const study2 = await tx.study.findUnique({ where: { id: studyId }, select: { requiredSampleSize: true } });
      const requiredSampleSize = study2?.requiredSampleSize ?? null;

      // 1. Fetch all response severity scores for this scope
      const responseScores = await tx.responseSeverityScore.findMany({
        where: {
          studyId,
          surveyId,
          methodologyVersionId,
          ...(villageId !== null ? { villageId } : {}),
        }
      });

      // 2. Fetch this methodology version's Question Bank to map hierarchies
      // (domain, subDomain, indicator, kpi). Version-scoped (RIO-AI-005): the
      // map below is keyed by `questionId`, so questions from another imported
      // bank would shadow this version's own rows and silently roll scores up
      // under a retired version's hierarchy.
      const questions = await tx.question.findMany({
        where: { methodologyVersionId, usedInMvp: true }
      });

      // Map questionId -> Question record
      const questionMap = new Map<string, (typeof questions)[number]>();
      for (const q of questions) {
        questionMap.set(q.questionId, q);
      }

      // Group response severity scores by questionId
      const scoresByQuestion = new Map<string, typeof responseScores>();
      for (const score of responseScores) {
        if (!scoresByQuestion.has(score.questionId)) {
          scoresByQuestion.set(score.questionId, []);
        }
        scoresByQuestion.get(score.questionId)!.push(score);
      }

      // Calculate Question-level rollups
      const questionRollups = new Map<string, {
        severityScore: number | null;
        validResponseCount: number;
        excludedResponseCount: number;
        dontKnowCount: number;
        dontKnowRate: number;
        notApplicableCount: number;
        confidenceLevel: 'LOW' | 'STANDARD';
      }>();

      for (const [qId, qScores] of scoresByQuestion.entries()) {
        const questionDef = questionMap.get(qId);
        if (!questionDef) continue;

        const scoredItems = qScores.filter(s => s.scoreStatus === 'SCORED' && s.severityScore !== null);
        const validCount = scoredItems.length;
        const excludedCount = qScores.filter(s => s.scoreStatus === 'EXCLUDED').length;
        const dontKnowCount = qScores.filter(s => s.exclusionReason === 'DONT_KNOW').length;
        const notApplicableCount = qScores.filter(s => s.scoreStatus === 'NOT_APPLICABLE').length;

        let avgScore: number | null = null;
        if (validCount > 0) {
          const sum = scoredItems.reduce((acc, curr) => acc + Number(curr.severityScore), 0);
          avgScore = sum / validCount;
        }

        const totalForDkRate = validCount + dontKnowCount;
        const dontKnowRate = totalForDkRate > 0 ? (dontKnowCount / totalForDkRate) : 0;
        const confidenceLevel = this.isLowConfidence(validCount, dontKnowRate, requiredSampleSize, confidenceFlagSettings) ? 'LOW' : 'STANDARD';

        questionRollups.set(qId, {
          severityScore: avgScore,
          validResponseCount: validCount,
          excludedResponseCount: excludedCount,
          dontKnowCount,
          dontKnowRate,
          notApplicableCount,
          confidenceLevel,
        });

        // Save rollup
        await this.upsertRollup(tx, {
          orgId: survey.orgId,
          studyId,
          surveyId,
          villageId,
          methodologyVersionId,
          rollupLevel: 'QUESTION',
          entityId: qId,
          entityNameSnapshot: questionDef.questionText,
          severityScore: avgScore,
          validResponseCount: validCount,
          excludedResponseCount: excludedCount,
          dontKnowCount,
          dontKnowRate,
          notApplicableCount,
          confidenceLevel,
        });
      }

      // Group Question Rollups by KPI
      const kpis = new Map<string, string[]>(); // kpiName -> questionIds
      for (const q of questions) {
        if (q.kpi) {
          if (!kpis.has(q.kpi)) {
            kpis.set(q.kpi, []);
          }
          kpis.get(q.kpi)!.push(q.questionId);
        }
      }

      const kpiRollups = new Map<string, RollupAggregate>();
      for (const [kpiName, qIds] of kpis.entries()) {
        const childRollups = qIds.map(id => questionRollups.get(id)).filter(Boolean);
        if (childRollups.length === 0) continue;

        const scoredChildren = childRollups.filter(r => r!.severityScore !== null);
        let kpiScore: number | null = null;
        if (scoredChildren.length > 0) {
          kpiScore = scoredChildren.reduce((acc, curr) => acc + curr!.severityScore!, 0) / scoredChildren.length;
        }

        const avgValidCount = Math.round(childRollups.reduce((acc, curr) => acc + curr!.validResponseCount, 0) / childRollups.length);
        const avgExcludedCount = Math.round(childRollups.reduce((acc, curr) => acc + curr!.excludedResponseCount, 0) / childRollups.length);
        const avgDkCount = Math.round(childRollups.reduce((acc, curr) => acc + curr!.dontKnowCount, 0) / childRollups.length);
        const avgDkRate = childRollups.reduce((acc, curr) => acc + curr!.dontKnowRate, 0) / childRollups.length;
        const avgNaCount = Math.round(childRollups.reduce((acc, curr) => acc + curr!.notApplicableCount, 0) / childRollups.length);
        const confidenceLevel = this.isLowConfidence(avgValidCount, avgDkRate, requiredSampleSize, confidenceFlagSettings) ? 'LOW' : 'STANDARD';

        kpiRollups.set(kpiName, { severityScore: kpiScore, confidenceLevel, validResponseCount: avgValidCount, dontKnowRate: avgDkRate });

        await this.upsertRollup(tx, {
          orgId: survey.orgId,
          studyId,
          surveyId,
          villageId,
          methodologyVersionId,
          rollupLevel: 'KPI',
          entityId: kpiName,
          entityNameSnapshot: kpiName,
          severityScore: kpiScore,
          validResponseCount: avgValidCount,
          excludedResponseCount: avgExcludedCount,
          dontKnowCount: avgDkCount,
          dontKnowRate: avgDkRate,
          notApplicableCount: avgNaCount,
          confidenceLevel,
        });
      }

      // Group KPIs by Indicator
      const indicators = new Map<string, string[]>(); // indicatorName -> kpiNames
      for (const q of questions) {
        if (q.indicator && q.kpi) {
          if (!indicators.has(q.indicator)) {
            indicators.set(q.indicator, []);
          }
          const list = indicators.get(q.indicator)!;
          if (!list.includes(q.kpi)) list.push(q.kpi);
        }
      }

      const indicatorRollups = new Map<string, RollupAggregate>();
      for (const [indName, kNames] of indicators.entries()) {
        const childRollups = kNames.map(name => kpiRollups.get(name)).filter(Boolean);
        if (childRollups.length === 0) continue;

        const scoredChildren = childRollups.filter(r => r!.severityScore !== null);
        let indScore: number | null = null;
        if (scoredChildren.length > 0) {
          indScore = scoredChildren.reduce((acc, curr) => acc + curr!.severityScore!, 0) / scoredChildren.length;
        }

        const avgValidCount = Math.round(childRollups.reduce((acc, curr) => acc + curr!.validResponseCount, 0) / childRollups.length);
        const avgDkRate = childRollups.reduce((acc, curr) => acc + curr!.dontKnowRate, 0) / childRollups.length;
        const confidenceLevel = this.isLowConfidence(avgValidCount, avgDkRate, requiredSampleSize, confidenceFlagSettings) ? 'LOW' : 'STANDARD';

        indicatorRollups.set(indName, { severityScore: indScore, confidenceLevel, validResponseCount: avgValidCount, dontKnowRate: avgDkRate });

        await this.upsertRollup(tx, {
          orgId: survey.orgId,
          studyId,
          surveyId,
          villageId,
          methodologyVersionId,
          rollupLevel: 'INDICATOR',
          entityId: indName,
          entityNameSnapshot: indName,
          severityScore: indScore,
          validResponseCount: avgValidCount,
          excludedResponseCount: 0,
          dontKnowCount: 0,
          dontKnowRate: avgDkRate,
          notApplicableCount: 0,
          confidenceLevel,
        });
      }

      // Group Indicators by Sub-Domain
      const subDomains = new Map<string, string[]>(); // subDomainName -> indicatorNames
      for (const q of questions) {
        if (q.subDomain && q.indicator) {
          if (!subDomains.has(q.subDomain)) {
            subDomains.set(q.subDomain, []);
          }
          const list = subDomains.get(q.subDomain)!;
          if (!list.includes(q.indicator)) list.push(q.indicator);
        }
      }

      const subDomainRollups = new Map<string, RollupAggregate>();
      for (const [subName, iNames] of subDomains.entries()) {
        const childRollups = iNames.map(name => indicatorRollups.get(name)).filter(Boolean);
        if (childRollups.length === 0) continue;

        const scoredChildren = childRollups.filter(r => r!.severityScore !== null);
        let subScore: number | null = null;
        if (scoredChildren.length > 0) {
          subScore = scoredChildren.reduce((acc, curr) => acc + curr!.severityScore!, 0) / scoredChildren.length;
        }

        const avgValidCount = Math.round(childRollups.reduce((acc, curr) => acc + curr!.validResponseCount, 0) / childRollups.length);
        const avgDkRate = childRollups.reduce((acc, curr) => acc + curr!.dontKnowRate, 0) / childRollups.length;
        const confidenceLevel = this.isLowConfidence(avgValidCount, avgDkRate, requiredSampleSize, confidenceFlagSettings) ? 'LOW' : 'STANDARD';

        subDomainRollups.set(subName, { severityScore: subScore, confidenceLevel, validResponseCount: avgValidCount, dontKnowRate: avgDkRate });

        await this.upsertRollup(tx, {
          orgId: survey.orgId,
          studyId,
          surveyId,
          villageId,
          methodologyVersionId,
          rollupLevel: 'SUB_DOMAIN',
          entityId: subName,
          entityNameSnapshot: subName,
          severityScore: subScore,
          validResponseCount: avgValidCount,
          excludedResponseCount: 0,
          dontKnowCount: 0,
          dontKnowRate: avgDkRate,
          notApplicableCount: 0,
          confidenceLevel,
        });
      }

      // Group Sub-Domains by Domain
      const domains = new Map<string, string[]>(); // domainName -> subDomainNames
      for (const q of questions) {
        if (q.domain && q.subDomain) {
          if (!domains.has(q.domain)) {
            domains.set(q.domain, []);
          }
          const list = domains.get(q.domain)!;
          if (!list.includes(q.subDomain)) list.push(q.subDomain);
        }
      }

      const domainRollups = new Map<string, RollupAggregate>();
      for (const [domName, sNames] of domains.entries()) {
        const childRollups = sNames.map(name => subDomainRollups.get(name)).filter(Boolean);
        if (childRollups.length === 0) continue;

        const scoredChildren = childRollups.filter(r => r!.severityScore !== null);
        let domScore: number | null = null;
        if (scoredChildren.length > 0) {
          domScore = scoredChildren.reduce((acc, curr) => acc + curr!.severityScore!, 0) / scoredChildren.length;
        }

        const avgValidCount = Math.round(childRollups.reduce((acc, curr) => acc + curr!.validResponseCount, 0) / childRollups.length);
        const avgDkRate = childRollups.reduce((acc, curr) => acc + curr!.dontKnowRate, 0) / childRollups.length;
        const confidenceLevel = this.isLowConfidence(avgValidCount, avgDkRate, requiredSampleSize, confidenceFlagSettings) ? 'LOW' : 'STANDARD';

        domainRollups.set(domName, { severityScore: domScore, confidenceLevel, validResponseCount: avgValidCount, dontKnowRate: avgDkRate });

        await this.upsertRollup(tx, {
          orgId: survey.orgId,
          studyId,
          surveyId,
          villageId,
          methodologyVersionId,
          rollupLevel: 'DOMAIN',
          entityId: domName,
          entityNameSnapshot: domName,
          severityScore: domScore,
          validResponseCount: avgValidCount,
          excludedResponseCount: 0,
          dontKnowCount: 0,
          dontKnowRate: avgDkRate,
          notApplicableCount: 0,
          confidenceLevel,
        });
      }

      // Calculate Overall Index (Overall Village Development Needs Index)
      const childRollups = Array.from(domainRollups.values());
      if (childRollups.length > 0) {
        const scoredChildren = childRollups.filter(r => r.severityScore !== null);
        let overallScore: number | null = null;
        if (scoredChildren.length > 0) {
          overallScore = scoredChildren.reduce((acc, curr) => acc + curr.severityScore!, 0) / scoredChildren.length;
        }

        const avgValidCount = Math.round(childRollups.reduce((acc, curr) => acc + curr.validResponseCount, 0) / childRollups.length);
        const avgDkRate = childRollups.reduce((acc, curr) => acc + curr.dontKnowRate, 0) / childRollups.length;
        const confidenceLevel = this.isLowConfidence(avgValidCount, avgDkRate, requiredSampleSize, confidenceFlagSettings) ? 'LOW' : 'STANDARD';

        await this.upsertRollup(tx, {
          orgId: survey.orgId,
          studyId,
          surveyId,
          villageId,
          methodologyVersionId,
          rollupLevel: 'OVERALL',
          entityId: 'OVERALL',
          entityNameSnapshot: 'Village Development Needs Index',
          severityScore: overallScore,
          validResponseCount: avgValidCount,
          excludedResponseCount: 0,
          dontKnowCount: 0,
          dontKnowRate: avgDkRate,
          notApplicableCount: 0,
          confidenceLevel,
        });
      }
    };

    if (options?.tx) {
      await body(options.tx);
    } else if (options?.orgId) {
      await this.tenant.runAsOrg(options.orgId, body);
    } else {
      await this.tenant.runInOrgContext(body);
    }
  }

  private async upsertRollup(
    tx: Prisma.TransactionClient,
    data: {
      orgId: string;
      studyId: string;
      surveyId: string;
      villageId: string | null;
      methodologyVersionId: string;
      rollupLevel: string;
      entityId: string;
      entityNameSnapshot: string;
      severityScore: number | null;
      validResponseCount: number;
      excludedResponseCount: number;
      dontKnowCount: number;
      dontKnowRate: number;
      notApplicableCount: number;
      confidenceLevel: string;
    }
  ) {
    const { orgId } = data;

    const uniqueWhere = {
      studyId_surveyId_villageId_methodologyVersionId_rollupLevel_entityId: {
        studyId: data.studyId,
        surveyId: data.surveyId,
        villageId: data.villageId || '', // Prisma does not support null in unique constraints, so store empty string as null representation
        methodologyVersionId: data.methodologyVersionId,
        rollupLevel: data.rollupLevel,
        entityId: data.entityId,
      }
    };

    const decimalScore = data.severityScore !== null ? new Prisma.Decimal(data.severityScore) : null;
    const decimalDkRate = new Prisma.Decimal(data.dontKnowRate);

    const existing = await tx.scoreRollup.findUnique({
      where: uniqueWhere
    });

    if (existing) {
      await tx.scoreRollup.update({
        where: { id: existing.id },
        data: {
          entityNameSnapshot: data.entityNameSnapshot,
          severityScore: decimalScore,
          validResponseCount: data.validResponseCount,
          excludedResponseCount: data.excludedResponseCount,
          dontKnowCount: data.dontKnowCount,
          dontKnowRate: decimalDkRate,
          notApplicableCount: data.notApplicableCount,
          confidenceLevel: data.confidenceLevel,
          calculatedAt: new Date(),
        }
      });
    } else {
      await tx.scoreRollup.create({
        data: {
          orgId,
          studyId: data.studyId,
          surveyId: data.surveyId,
          villageId: data.villageId || '',
          methodologyVersionId: data.methodologyVersionId,
          rollupLevel: data.rollupLevel,
          entityId: data.entityId,
          entityNameSnapshot: data.entityNameSnapshot,
          severityScore: decimalScore,
          validResponseCount: data.validResponseCount,
          excludedResponseCount: data.excludedResponseCount,
          dontKnowCount: data.dontKnowCount,
          dontKnowRate: decimalDkRate,
          notApplicableCount: data.notApplicableCount,
          confidenceLevel: data.confidenceLevel,
          calculationVersion: 'v1',
        }
      });
    }
  }
}
