import { Injectable, Logger } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { Prisma } from '../../generated/prisma';

@Injectable()
export class DeterministicScoringService {
  private readonly logger = new Logger(DeterministicScoringService.name);

  constructor(private readonly tenant: TenantPrismaService) {}

  /**
   * Normalize raw response display labels into stable option IDs.
   */
  toOptionId(label: string): string {
    if (!label) return '';
    return label
      .toUpperCase()
      .trim()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  /**
   * Score a SurveyResponse submission:
   * 1. Extract and validate answers against SurveyQuestions and Question Bank.
   * 2. Save ResponseAnswer records.
   * 3. Evaluate conditional rules (applicability) and scoreability.
   * 4. Resolve lookups and compute individual severity scores (0 - 100).
   * 5. Save ResponseSeverityScore records.
   */
  async scoreResponse(surveyResponseId: string): Promise<void> {
    await this.tenant.runInOrgContext(async (tx) => {
      // 1. Fetch SurveyResponse
      const response = await tx.surveyResponse.findUnique({
        where: { id: surveyResponseId },
        include: {
          surveyLink: true,
          need: true,
        }
      });
      if (!response) {
        throw new Error(`SurveyResponse not found: ${surveyResponseId}`);
      }

      const { needId, studyId, orgId, surveyLinkId } = response;
      const villageId = response.need.village?.[0] || null;
      const respondentId = response.contact;

      // Find the published survey for this Need
      const survey = await tx.survey.findFirst({
        where: { needId, status: 'PUBLISHED' },
        include: {
          surveyQuestions: {
            include: {
              question: true
            }
          }
        }
      });
      if (!survey) {
        throw new Error(`No published survey found for need: ${needId}`);
      }

      // Determine Methodology Version
      // If the survey has a snapshot version, find it, otherwise fall back to latest published version
      let methodologyVersion = await tx.methodologyVersion.findFirst({
        where: survey.methodologyVersion ? { version: survey.methodologyVersion } : { status: 'PUBLISHED' },
        orderBy: { createdAt: 'desc' }
      });
      if (!methodologyVersion) {
        throw new Error(`No published methodology version found`);
      }

      // Read raw answers from response JSON
      // Answers is a Record of surveyQuestionId -> answerValue
      const rawAnswers = (response.answers || {}) as Record<string, any>;

      // Load all scoring lookups for this methodology version
      const lookups = await tx.scoringLookup.findMany({
        where: { methodologyVersionId: methodologyVersion.id, isActive: true }
      });

      // Map raw answers to a structured map for rule evaluation
      // Key: questionId (e.g. H01), Value: { optionId, optionIds, numericValue, text }
      const answersMapByQuestionId = new Map<string, {
        optionId: string | null;
        optionIds: string[] | null;
        numericValue: number | null;
        text: string | null;
      }>();

      const questionMappings: Array<{
        surveyQuestionId: string;
        question: any;
        rawAnswer: any;
      }> = [];

      for (const sq of survey.surveyQuestions) {
        const rawAnswer = rawAnswers[sq.id];
        if (sq.question) {
          const q = sq.question;
          const parsed = this.parseRawAnswerValue(rawAnswer, q.measurementMode);
          answersMapByQuestionId.set(q.questionId, parsed);
          questionMappings.push({ surveyQuestionId: sq.id, question: q, rawAnswer });
        }
      }

      // Process each question
      for (const { surveyQuestionId, question, rawAnswer } of questionMappings) {
        const qId = question.questionId;
        const parsed = answersMapByQuestionId.get(qId)!;

        // Save ResponseAnswer record
        const answerRecord = await tx.responseAnswer.create({
          data: {
            orgId,
            surveyResponseId,
            surveyId: survey.id,
            studyId,
            villageId,
            respondentId,
            questionId: qId,
            answerOptionId: parsed.optionId,
            answerNumericValue: parsed.numericValue !== null ? new Prisma.Decimal(parsed.numericValue) : null,
            answerText: parsed.text,
            answerOptionIds: parsed.optionIds ? JSON.parse(JSON.stringify(parsed.optionIds)) : null,
            isApplicable: true, // Default to true, will update if conditional rule fails
            submittedAt: response.submittedAt,
          }
        });

        // Evaluate applicability (conditional rule)
        const isApplicable = this.evaluateConditionalRule(question, answersMapByQuestionId);
        if (!isApplicable) {
          await tx.responseAnswer.update({
            where: { id: answerRecord.id },
            data: { isApplicable: false }
          });

          await tx.responseSeverityScore.create({
            data: {
              orgId,
              responseAnswerId: answerRecord.id,
              surveyResponseId,
              surveyId: survey.id,
              studyId,
              villageId,
              questionId: qId,
              methodologyVersionId: methodologyVersion.id,
              rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
              severityScore: null,
              scoreStatus: 'NOT_APPLICABLE',
              calculationVersion: 'v1',
            }
          });
          continue;
        }

        // Evaluate scoreability
        if (!question.isScoreable) {
          await tx.responseSeverityScore.create({
            data: {
              orgId,
              responseAnswerId: answerRecord.id,
              surveyResponseId,
              surveyId: survey.id,
              studyId,
              villageId,
              questionId: qId,
              methodologyVersionId: methodologyVersion.id,
              rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
              severityScore: null,
              scoreStatus: 'NOT_SCOREABLE',
              calculationVersion: 'v1',
            }
          });
          continue;
        }

        // Handle missing answer
        if (
          parsed.optionId === null &&
          (parsed.optionIds === null || parsed.optionIds.length === 0) &&
          parsed.numericValue === null &&
          parsed.text === null
        ) {
          await tx.responseSeverityScore.create({
            data: {
              orgId,
              responseAnswerId: answerRecord.id,
              surveyResponseId,
              surveyId: survey.id,
              studyId,
              villageId,
              questionId: qId,
              methodologyVersionId: methodologyVersion.id,
              rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
              severityScore: null,
              scoreStatus: 'EXCLUDED',
              exclusionReason: 'MISSING_ANSWER',
              calculationVersion: 'v1',
            }
          });
          continue;
        }

        // Handle Don't Know / Not Applicable options directly
        const checkExclusion = this.getOptionExclusion(parsed.optionId, lookups, qId);
        if (checkExclusion) {
          await tx.responseSeverityScore.create({
            data: {
              orgId,
              responseAnswerId: answerRecord.id,
              surveyResponseId,
              surveyId: survey.id,
              studyId,
              villageId,
              questionId: qId,
              methodologyVersionId: methodologyVersion.id,
              scoringLookupId: checkExclusion.lookupId,
              rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
              severityScore: null,
              scoreStatus: 'EXCLUDED',
              exclusionReason: checkExclusion.exclusionReason,
              calculationVersion: 'v1',
            }
          });
          continue;
        }

        // Compute Severity Score based on measurement mode
        try {
          const scoreResult = this.calculateSeverity(question, parsed, lookups);
          await tx.responseSeverityScore.create({
            data: {
              orgId,
              responseAnswerId: answerRecord.id,
              surveyResponseId,
              surveyId: survey.id,
              studyId,
              villageId,
              questionId: qId,
              methodologyVersionId: methodologyVersion.id,
              scoringLookupId: scoreResult.scoringLookupId,
              rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
              severityScore: scoreResult.score !== null ? new Prisma.Decimal(scoreResult.score) : null,
              scoreStatus: scoreResult.status,
              exclusionReason: scoreResult.exclusionReason,
              calculationVersion: 'v1',
            }
          });
        } catch (e: any) {
          this.logger.error(`Error scoring question ${qId}: ${e.message}`);
          await tx.responseSeverityScore.create({
            data: {
              orgId,
              responseAnswerId: answerRecord.id,
              surveyResponseId,
              surveyId: survey.id,
              studyId,
              villageId,
              questionId: qId,
              methodologyVersionId: methodologyVersion.id,
              rawAnswerSnapshot: JSON.parse(JSON.stringify({ rawAnswer })),
              severityScore: null,
              scoreStatus: 'ERROR',
              exclusionReason: 'MISSING_LOOKUP',
              calculationVersion: 'v1',
            }
          });
        }
      }
    });
  }

  private parseRawAnswerValue(
    raw: any,
    mode: string
  ): {
    optionId: string | null;
    optionIds: string[] | null;
    numericValue: number | null;
    text: string | null;
  } {
    const res = { optionId: null as string | null, optionIds: null as string[] | null, numericValue: null as number | null, text: null as string | null };
    if (raw === null || raw === undefined || raw === '') return res;

    if (mode === 'NUMERIC') {
      const val = Number(raw);
      if (!Number.isNaN(val)) res.numericValue = val;
    } else if (mode === 'MULTI_SELECT') {
      if (Array.isArray(raw)) {
        res.optionIds = raw.map(o => this.toOptionId(String(o)));
      } else if (typeof raw === 'string') {
        res.optionIds = raw.split(',').map(o => this.toOptionId(o.trim()));
      }
    } else if (mode === 'OPEN_TEXT') {
      res.text = String(raw);
    } else {
      // SINGLE_SELECT, LIKERT_5, DIAGNOSTIC
      res.optionId = this.toOptionId(String(raw));
    }
    return res;
  }

  private evaluateConditionalRule(question: any, answersMap: Map<string, any>): boolean {
    if (!question.conditionalRule) return true;
    try {
      const rule = typeof question.conditionalRule === 'string'
        ? JSON.parse(question.conditionalRule)
        : question.conditionalRule;
      if (rule && rule.dependsOn) {
        const parent = answersMap.get(rule.dependsOn);
        if (!parent) return false;

        if (rule.value !== undefined) {
          if (parent.optionIds && Array.isArray(parent.optionIds)) {
            return parent.optionIds.includes(rule.value);
          }
          return parent.optionId === rule.value;
        }
      }
    } catch (e) {
      this.logger.error(`Error parsing conditional rule on question ${question.questionId}`, e);
    }
    return true;
  }

  private getOptionExclusion(optionId: string | null, lookups: any[], questionId: string) {
    if (!optionId) return null;
    const lookup = lookups.find(l => l.questionId === questionId && l.optionId === optionId);
    if (lookup && lookup.isExcluded) {
      return {
        lookupId: lookup.id,
        exclusionReason: lookup.exclusionReason || 'DONT_KNOW',
      };
    }
    return null;
  }

  private calculateSeverity(
    question: any,
    parsed: any,
    lookups: any[]
  ): {
    score: number | null;
    status: string;
    scoringLookupId: string | null;
    exclusionReason?: string;
  } {
    const qId = question.questionId;
    const mode = question.measurementMode;

    if (mode === 'NUMERIC') {
      const lookup = lookups.find(l => l.questionId === qId && l.lookupType === 'NUMERIC');
      if (!lookup) {
        throw new Error(`No numeric lookup config found for question: ${qId}`);
      }

      const floor = lookup.numericFloor !== null ? Number(lookup.numericFloor) : 0;
      const ceiling = lookup.numericCeiling !== null ? Number(lookup.numericCeiling) : 100;
      const direction = lookup.severityDirection || 'WORSENING_HIGHER';
      const answerVal = parsed.numericValue ?? floor;

      let score = 0;
      if (direction === 'WORSENING_HIGHER') {
        const ratio = (answerVal - floor) / (ceiling - floor);
        score = 100 * Math.max(0, Math.min(1, ratio));
      } else {
        const ratio = (ceiling - answerVal) / (ceiling - floor);
        score = 100 * Math.max(0, Math.min(1, ratio));
      }

      return { score, status: 'SCORED', scoringLookupId: lookup.id };
    }

    if (mode === 'MULTI_SELECT') {
      const selected = parsed.optionIds || [];
      const relevantLookups = lookups.filter(l => l.questionId === qId && l.lookupType === 'MULTI_SELECT');
      if (relevantLookups.length === 0) {
        throw new Error(`No multi-select lookups found for question: ${qId}`);
      }

      let sum = 0;
      let usedLookupId = relevantLookups[0]?.id; // default to first lookup record as primary tracking lookup
      for (const opt of selected) {
        const match = relevantLookups.find(l => l.optionId === opt);
        if (match) {
          sum += Number(match.severityScore || 0);
        }
      }
      const score = Math.min(sum, 100);
      return { score, status: 'SCORED', scoringLookupId: usedLookupId };
    }

    // SINGLE_SELECT or LIKERT_5
    const lookupType = mode === 'LIKERT_5' ? 'LIKERT' : 'OPTION';
    const match = lookups.find(l => l.questionId === qId && l.lookupType === lookupType && l.optionId === parsed.optionId);
    if (!match) {
      throw new Error(`No lookup found for question: ${qId}, optionId: ${parsed.optionId}`);
    }

    if (match.isExcluded) {
      return {
        score: null,
        status: 'EXCLUDED',
        scoringLookupId: match.id,
        exclusionReason: match.exclusionReason || 'DONT_KNOW'
      };
    }

    return {
      score: match.severityScore !== null ? Number(match.severityScore) : null,
      status: 'SCORED',
      scoringLookupId: match.id
    };
  }
}
