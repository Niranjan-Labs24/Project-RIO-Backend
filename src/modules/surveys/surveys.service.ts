import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import { AiService } from '../ai/ai.service';

@Injectable()
export class SurveysService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly ai: AiService,
  ) {}

  async getSurveyByStudyId(studyId: string) {
    const row = await this.tenant.runInOrgContext(async (tx) => {
      const survey = await tx.survey.findFirst({
        where: { studyId },
        include: {
          surveyQuestions: {
            orderBy: { order: 'asc' },
            include: { question: true },
          },
        },
      });
      return survey;
    });

    if (!row) return null;

    return {
      id: row.id,
      studyId: row.studyId,
      title: row.title,
      status: row.status,
      questions: row.surveyQuestions.map((sq) => ({
        id: sq.question.id,
        questionId: sq.question.questionId,
        questionText: sq.question.questionText,
        answerType: sq.question.answerType,
        answerOptions: typeof sq.question.answerOptions === 'string' ? JSON.parse(sq.question.answerOptions) : sq.question.answerOptions,
        requiredOptional: sq.question.requiredOptional,
        order: sq.order,
        isRequired: sq.isRequired,
        indicator: sq.question.indicator,
        kpi: sq.question.kpi,
      })),
    };
  }

  async recommendQuestions(studyId: string): Promise<any> {
    const orgId = requireOrgId();
    const actorId = requireActor();

    const data = await this.tenant.runInOrgContext(async (tx) => {
      const study = await tx.study.findUnique({ where: { id: studyId } });
      if (!study) {
        throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      }

      if (!study.domain || !study.subDomain) {
        throw new BadRequestException({
          error: { code: 'NO_APPROVED_DOMAIN', message: 'Select and approve a domain/subdomain first.' },
        });
      }

      const eligibleQuestions = await tx.question.findMany({
        where: { domain: study.domain, subDomain: study.subDomain, usedInMvp: true },
      });

      return { study, eligibleQuestions };
    });

    const { study, eligibleQuestions } = data;
    if (eligibleQuestions.length === 0) {
      throw new ConflictException({
        error: { code: 'NO_ELIGIBLE_QUESTIONS', message: 'No questions found in this domain/subdomain' },
      });
    }

    const systemInstruction = `You are a survey question recommendation assistant. You must recommend only question IDs from the provided eligible questions list. Do not create new question text. Do not edit question text. Return valid JSON only.`;

    const prompt = `Problem Statement: "${study.problemStatement || ''}"
Approved Domain: "${study.domain}"
Approved SubDomain: "${study.subDomain}"
Eligible Questions: ${JSON.stringify(
      eligibleQuestions.map((q) => ({
        questionId: q.questionId,
        questionText: q.questionText,
        answerType: q.answerType,
        answerOptions: typeof q.answerOptions === 'string' ? JSON.parse(q.answerOptions) : q.answerOptions,
        indicator: q.indicator,
        kpi: q.kpi,
      })),
    )}`;

    const responseSchema = {
      type: 'object',
      properties: {
        recommendedQuestionIds: {
          type: 'array',
          items: { type: 'string' },
        },
        confidence: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['recommendedQuestionIds', 'confidence', 'reason'],
    };

    let recommendedQuestionIds: string[] = [];
    let confidence = 0;
    let reason = '';
    let raw: any = null;

    try {
      const result = await this.ai.generateJson<any>(prompt, systemInstruction, responseSchema);
      recommendedQuestionIds = result.response.recommendedQuestionIds || [];
      confidence = result.response.confidence || 0;
      reason = result.response.reason || '';
      raw = result.raw;
    } catch (err: any) {
      throw new BadRequestException({
        error: { code: 'AI_SURVEY_GENERATION_FAILED', message: `AI survey generation failed: ${err.message}` }
      });
    }

    // Validate recommended questions exist in DB and match the criteria
    const validatedQuestions = eligibleQuestions.filter((q) =>
      recommendedQuestionIds.includes(q.questionId),
    );

    // If validation results in 0 questions, use all eligible questions as fallback
    const finalQuestions = validatedQuestions.length > 0 ? validatedQuestions : eligibleQuestions;

    // Log AI Suggestion
    const suggestion = await this.tenant.runInOrgContext(async (tx) =>
      tx.aiSuggestion.create({
        data: {
          orgId,
          studyId,
          type: 'QUESTION_RECOMMENDATION',
          suggestedQuestionIds: finalQuestions.map((q) => q.questionId),
          confidence,
          reason,
          modelName: 'gemini-2.5-flash',
          promptVersion: '1.0.0',
          rawResponse: raw as any,
          createdBy: actorId,
        },
      }),
    );

    // Create or update survey draft
    const survey = await this.tenant.runInOrgContext(async (tx) => {
      let existingSurvey = await tx.survey.findFirst({ where: { studyId } });
      if (!existingSurvey) {
        existingSurvey = await tx.survey.create({
          data: {
            orgId,
            studyId,
            title: `Survey: ${study.title}`,
            status: 'DRAFT',
            createdBy: actorId,
          },
        });
      } else {
        existingSurvey = await tx.survey.update({
          where: { id: existingSurvey.id },
          data: { title: `Survey: ${study.title}` },
        });
      }

      // Recreate SurveyQuestions links
      await tx.surveyQuestion.deleteMany({ where: { surveyId: existingSurvey.id } });
      await tx.surveyQuestion.createMany({
        data: finalQuestions.map((q, idx) => ({
          surveyId: existingSurvey.id,
          questionId: q.id,
          order: idx + 1,
          isRequired: q.requiredOptional === 'required',
        })),
      });

      return existingSurvey;
    });

    await this.audit.record({
      action: 'create',
      entityType: 'survey',
      entityId: survey.id,
      entityLabel: `AI recommended survey questions for study ${studyId}`,
    });

    return this.getSurveyByStudyId(studyId);
  }

  async updateQuestions(
    surveyId: string,
    questions: Array<{ questionId: string; order: number; isRequired: boolean }>,
  ) {
    const orgId = requireOrgId();
    const actorId = requireActor();

    await this.tenant.runInOrgContext(async (tx) => {
      const survey = await tx.survey.findUnique({ where: { id: surveyId } });
      if (!survey) {
        throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
      }

      // Re-create the links using incoming array
      await tx.surveyQuestion.deleteMany({ where: { surveyId } });
      await tx.surveyQuestion.createMany({
        data: questions.map((q) => ({
          surveyId,
          questionId: q.questionId, // DB id (Uuid) of the question
          order: q.order,
          isRequired: q.isRequired,
        })),
      });
    });

    await this.audit.record({
      action: 'edit',
      entityType: 'survey',
      entityId: surveyId,
      entityLabel: `Survey questions updated manually`,
    });

    return { success: true };
  }

  async saveDraft(surveyId: string, status: string = 'DRAFT') {
    const updated = await this.tenant.runInOrgContext(async (tx) => {
      const survey = await tx.survey.findUnique({ where: { id: surveyId } });
      if (!survey) {
        throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
      }
      return tx.survey.update({
        where: { id: surveyId },
        data: { status },
      });
    });

    await this.audit.record({
      action: 'edit',
      entityType: 'survey',
      entityId: surveyId,
      entityLabel: `Survey saved as draft`,
    });

    return updated;
  }

  async getPublicSurvey(id: string): Promise<any> {
    return this.tenant.runAsSupervisor(async (tx) => {
      const survey = await tx.survey.findUnique({
        where: { id },
        include: {
          surveyQuestions: {
            include: {
              question: true
            },
            orderBy: {
              order: 'asc'
            }
          }
        }
      });

      if (!survey) {
        throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
      }

      if (survey.status !== 'PUBLISHED') {
        throw new ForbiddenException({ error: { code: 'SURVEY_NOT_PUBLISHED', message: 'This survey is not yet published.' } });
      }

      return {
        id: survey.id,
        title: survey.title,
        status: survey.status,
        questions: survey.surveyQuestions.map((sq: any) => ({
          id: sq.question.id,
          questionId: sq.question.questionId,
          questionText: sq.question.questionText,
          answerType: sq.question.answerType,
          answerOptions: sq.question.answerOptions ? (typeof sq.question.answerOptions === 'string' ? JSON.parse(sq.question.answerOptions) : sq.question.answerOptions) : null,
          isRequired: sq.isRequired,
          order: sq.order
        }))
      };
    });
  }

  async submitSurvey(surveyId: string, answers: Record<string, string>): Promise<any> {
    const survey = await this.tenant.runAsSupervisor(async (tx) => {
      return tx.survey.findUnique({ where: { id: surveyId } });
    });

    if (!survey) {
      throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
    }
    if (survey.status !== 'PUBLISHED') {
      throw new BadRequestException({ error: { code: 'SURVEY_NOT_PUBLISHED', message: 'This survey is not accepting submissions.' } });
    }

    return this.tenant.runAsOrg(survey.orgId, async (tx) => {
      return tx.surveyResponse.create({
        data: {
          surveyId,
          answers: answers as any
        }
      });
    });
  }

  async getSurveyResponses(surveyId: string): Promise<any> {
    return this.tenant.runAsSupervisor(async (tx) => {
      const survey = await tx.survey.findUnique({
        where: { id: surveyId },
        include: {
          surveyQuestions: {
            include: {
              question: true
            },
            orderBy: {
              order: 'asc'
            }
          },
          surveyResponses: true
        }
      });

      if (!survey) {
        throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
      }

      const totalRespondents = survey.surveyResponses.length;
      
      const computedStats = survey.surveyQuestions.map((sq: any) => {
        const q = sq.question;
        
        const answersList: string[] = [];
        survey.surveyResponses.forEach((resp: any) => {
          const ansObj = resp.answers as Record<string, unknown>;
          if (ansObj && typeof ansObj[q.id] === 'string') {
            answersList.push(ansObj[q.id] as string);
          }
        });

        const colors = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

        if (q.answerType === "select" || q.answerType === "boolean") {
          const options: string[] = q.answerOptions ? (typeof q.answerOptions === 'string' ? JSON.parse(q.answerOptions) : q.answerOptions) : (q.answerType === "boolean" ? ["Yes", "No"] : ["Don't know"]);
          
          const slices = options.map((opt, oIdx) => {
            const count = answersList.filter(ans => ans === opt).length;
            const percentage = totalRespondents > 0 ? Number(((count / totalRespondents) * 100).toFixed(1)) : 0;
            return {
              label: opt,
              count,
              percentage,
              color: colors[oIdx % colors.length]
            };
          });

          return {
            questionId: q.questionId,
            questionText: q.questionText,
            answerType: q.answerType,
            slices
          };
        }

        if (q.answerType === "numeric") {
          const numericAnswers = answersList.map(a => Number(a)).filter(n => !isNaN(n));
          
          const ranges = [
            { label: "0 - 15 minutes", filter: (n: number) => n <= 15 },
            { label: "15 - 30 minutes", filter: (n: number) => n > 15 && n <= 30 },
            { label: "30 - 60 minutes", filter: (n: number) => n > 30 && n <= 60 },
            { label: "Over 1 hour", filter: (n: number) => n > 60 }
          ];

          const slices = ranges.map((rng, rIdx) => {
            const count = numericAnswers.filter(rng.filter).length;
            const percentage = totalRespondents > 0 ? Number(((count / totalRespondents) * 100).toFixed(1)) : 0;
            return {
              label: rng.label,
              count,
              percentage,
              color: colors[rIdx % colors.length]
            };
          });

          return {
            questionId: q.questionId,
            questionText: q.questionText,
            answerType: q.answerType,
            slices
          };
        }

        return {
          questionId: q.questionId,
          questionText: q.questionText,
          answerType: q.answerType,
          slices: [],
          textResponses: answersList.slice(-10)
        };
      });

      return {
        id: survey.id,
        title: survey.title,
        status: survey.status,
        totalRespondents,
        stats: computedStats
      };
    });
  }
}
