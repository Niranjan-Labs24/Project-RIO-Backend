import { Injectable, Logger } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { Prisma, type Question } from '../../generated/prisma';
import { DeterministicScoringService, type ParsedAnswer } from './scoring.service';
import { PriorityV2Service, type RecalculateOutcome, type RecalculateReason } from './priority-v2.service';
import { MethodologyConfigService } from '../methodology-config/methodology-config.service';
import { computeRollups } from './rollup-compute';

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
   * Run a complete recalculation for all responses under a given study/survey.
   */
  async recalculateStudyScores(studyId: string, surveyId: string): Promise<RecalculateOutcome> {
    // Set by the transaction body's early exits below. The body used to
    // `return` silently, so the endpoint reported `{ success: true }` for a
    // run that scored nothing at all.
    let earlyExit: RecalculateReason | null = null;
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
      if (!survey) { earlyExit = 'SURVEY_NOT_FOUND'; return; }

      const responses = await tx.surveyResponse.findMany({
        where: { needId: survey.needId, exclusionReason: null },
        include: { need: true }
      });

      const responseIds = responses.map(r => r.id);
      if (responseIds.length === 0) { earlyExit = 'NO_RESPONSES'; return; }

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
      if (!mv) { earlyExit = 'NO_METHODOLOGY_VERSION'; return; }

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
            const parsed = this.scoringEngine.parseRawAnswerValue(rawAnswers[sq.id], q.measurementMode, q.questionId);
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
      const distinctVillages = Array.from(new Set(responses.flatMap(r => r.need.village)));
      for (const v of distinctVillages) {
        await this.calculateRollups(studyId, surveyId, v, { tx, orgId: survey.orgId });
      }
      await this.calculateRollups(studyId, surveyId, null, { tx, orgId: survey.orgId });
    });

    if (earlyExit) return { success: false, reason: earlyExit };

    // Call priority v2 recalculation
    return this.priorityV2.recalculateAll(studyId, surveyId);
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

      // RIO-FR-024 dual confidence criterion: see isLowConfidence (rollup-compute.ts).
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

      // 3. The maths lives in computeRollups (rollup-compute.ts) so a filtered
      // summary can run it without writing — see there. Persist every row it
      // returns, in its order (questions first, OVERALL last), as before.
      const rows = computeRollups(responseScores, questions, requiredSampleSize, confidenceFlagSettings);
      for (const row of rows) {
        await this.upsertRollup(tx, {
          orgId: survey.orgId,
          studyId,
          surveyId,
          villageId,
          methodologyVersionId,
          ...row,
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
