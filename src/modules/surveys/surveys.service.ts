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

  // Shared shape for both kinds of SurveyQuestion row — Question Bank
  // (question set, customText/customAnswerType null) and additional/
  // open-ended (question null, customText set). `id` is always the
  // SurveyQuestion row's own id — the one stable per-item key that exists
  // for both kinds — never the Question row's id, which additional
  // questions don't have. `bankQuestionId` is the Question row's id,
  // present only for bank questions, and is what a save must send back to
  // keep pointing at that same Question Bank row.
  private toQuestionDto(sq: {
    id: string;
    order: number;
    isRequired: boolean;
    customText: string | null;
    customAnswerType: string | null;
    customOptions: unknown;
    question: {
      id: string;
      questionId: string;
      questionText: string;
      answerType: string;
      answerOptions: unknown;
      indicator: string | null;
      kpi: string | null;
    } | null;
  }) {
    if (sq.question) {
      return {
        id: sq.id,
        bankQuestionId: sq.question.id,
        questionCode: sq.question.questionId,
        questionText: sq.question.questionText,
        answerType: sq.question.answerType,
        answerOptions:
          typeof sq.question.answerOptions === 'string'
            ? JSON.parse(sq.question.answerOptions)
            : sq.question.answerOptions,
        indicator: sq.question.indicator,
        kpi: sq.question.kpi,
        isCustom: false,
        order: sq.order,
        isRequired: sq.isRequired,
      };
    }
    return {
      id: sq.id,
      bankQuestionId: null,
      questionCode: null,
      questionText: sq.customText ?? '',
      answerType: sq.customAnswerType ?? 'long_text',
      answerOptions:
        typeof sq.customOptions === 'string' ? JSON.parse(sq.customOptions) : (sq.customOptions ?? null),
      indicator: null,
      kpi: null,
      isCustom: true,
      order: sq.order,
      isRequired: sq.isRequired,
    };
  }

  // Citizen flow's only entry point into Survey data — cross-org
  // SELECT-only (see TenantPrismaService.runAsSupervisor), since a citizen
  // request has no org context of its own. Always re-reads the currently
  // PUBLISHED survey fresh, so if a survey is edited and republished later,
  // the next citizen to open the link gets the latest version automatically
  // — nothing about a link points at a frozen snapshot.
  async getPublishedSurveyByStudyId(studyId: string) {
    return this.tenant.runAsSupervisor(async (tx) => {
      const survey = await tx.survey.findFirst({
        where: { studyId, status: 'PUBLISHED' },
        include: {
          surveyQuestions: {
            orderBy: { order: 'asc' },
            include: { question: true },
          },
        },
      });
      if (!survey) return null;
      return {
        id: survey.id,
        studyId: survey.studyId,
        title: survey.title,
        status: survey.status,
        questions: survey.surveyQuestions.map((sq) => this.toQuestionDto(sq)),
      };
    });
  }

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
      questions: row.surveyQuestions.map((sq) => this.toQuestionDto(sq)),
    };
  }

  // "Build Manually" path: Create Survey without calling Gemini — a bare
  // DRAFT survey with no questions yet, so the Survey Builder page has
  // something to attach questions to via its existing add-from-Question-Bank
  // combobox. Idempotent: if a survey already exists for this study (e.g.
  // AI suggestions were generated first, or this was already called), just
  // return it rather than wiping its questions.
  async createEmptySurvey(studyId: string): Promise<any> {
    const orgId = requireOrgId();
    const actorId = requireActor();

    const { survey, created } = await this.tenant.runInOrgContext(async (tx) => {
      const study = await tx.study.findUnique({ where: { id: studyId } });
      if (!study) {
        throw new NotFoundException({ error: { code: 'STUDY_NOT_FOUND', message: 'Study not found' } });
      }
      if (!study.domain || !study.subDomain) {
        throw new BadRequestException({
          error: {
            code: 'NO_APPROVED_DOMAIN',
            message: 'This study needs an approved AI Classification (domain/sub-domain) before generating a survey.',
          },
        });
      }

      const existing = await tx.survey.findFirst({ where: { studyId } });
      if (existing) return { survey: existing, created: false };

      const row = await tx.survey.create({
        data: { orgId, studyId, title: `Survey: ${study.title}`, status: 'DRAFT', createdBy: actorId },
      });
      return { survey: row, created: true };
    });

    if (created) {
      await this.audit.record({
        action: 'create',
        entityType: 'survey',
        entityId: survey.id,
        entityLabel: `Manually created survey for study ${studyId}`,
      });
    }

    return this.getSurveyByStudyId(studyId);
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
          error: {
            code: 'NO_APPROVED_DOMAIN',
            message: 'This study needs an approved AI Classification (domain/sub-domain) before generating a survey.',
          },
        });
      }

      // Problem description comes from the Need Statement (the existing
      // Need workflow), never a Study-level field — see the Need/Evidence/
      // AI Classification/Human Review BPM this reuses.
      const need = await tx.need.findUnique({ where: { studyId } });

      const eligibleQuestions = await tx.question.findMany({
        where: { domain: study.domain, subDomain: study.subDomain, usedInMvp: true },
      });

      return { study, need, eligibleQuestions };
    });

    const { study, need, eligibleQuestions } = data;
    if (eligibleQuestions.length === 0) {
      throw new ConflictException({
        error: { code: 'NO_ELIGIBLE_QUESTIONS', message: 'No questions found in this domain/subdomain' },
      });
    }

    const systemInstruction = `You are a survey question recommendation assistant. You must recommend only question IDs from the provided eligible questions list. Do not create new question text. Do not edit question text. Return valid JSON only.`;

    const prompt = `Need Statement: "${need?.statement ?? ''}"
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

      // Recreate only the Question Bank links — any additional/open-ended
      // questions already on this survey (customText set, questionId null)
      // are left untouched, since they're the Research Officer's own
      // additions, not something Gemini's suggestion should ever wipe out.
      await tx.surveyQuestion.deleteMany({ where: { surveyId: existingSurvey.id, questionId: { not: null } } });
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
    questions: Array<{
      questionId?: string;
      customText?: string;
      customAnswerType?: string;
      customOptions?: string[];
      order: number;
      isRequired: boolean;
    }>,
  ) {
    // Exactly one of questionId (a real Question Bank row) or customText
    // (an additional, study-only question) per item — never both, never
    // neither. Question Bank items are never editable here (no question
    // text/type/options/indicator/KPI change accepted) — only order and
    // isRequired travel through for them.
    for (const q of questions) {
      const hasBank = Boolean(q.questionId);
      const hasCustom = Boolean(q.customText);
      if (hasBank === hasCustom) {
        throw new BadRequestException({
          error: {
            code: 'INVALID_SURVEY_QUESTION',
            message: 'Each question must be either a Question Bank question or an additional question, not both or neither.',
          },
        });
      }
    }

    const studyId = await this.tenant.runInOrgContext(async (tx) => {
      const survey = await tx.survey.findUnique({ where: { id: surveyId } });
      if (!survey) {
        throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
      }

      // Re-create the links using the incoming array — the whole ordered
      // list (Question Bank + additional questions together) is the unit of
      // save, per the Survey Builder's single Save action.
      await tx.surveyQuestion.deleteMany({ where: { surveyId } });
      await tx.surveyQuestion.createMany({
        data: questions.map((q) => ({
          surveyId,
          questionId: q.questionId ?? null,
          customText: q.customText ?? null,
          customAnswerType: q.questionId ? null : (q.customAnswerType ?? 'long_text'),
          customOptions: q.questionId ? undefined : (q.customOptions ?? undefined),
          order: q.order,
          isRequired: q.isRequired,
        })),
      });

      return survey.studyId;
    });

    await this.audit.record({
      action: 'edit',
      entityType: 'survey',
      entityId: surveyId,
      entityLabel: `Survey questions updated manually`,
    });

    return this.getSurveyByStudyId(studyId);
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
        questions: survey.surveyQuestions.map((sq) => this.toQuestionDto(sq)),
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
      return tx.surveyBuilderResponse.create({
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
          builderResponses: true
        }
      });

      if (!survey) {
        throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
      }

      const totalRespondents = survey.builderResponses.length;

      // Answers are keyed by SurveyQuestion.id (see toQuestionDto/
      // getPublicSurvey) — the one id that exists for both a Question Bank
      // question and an additional/open-ended one, which has no Question
      // row to key off.
      const computedStats = survey.surveyQuestions.map((sq) => {
        const dto = this.toQuestionDto(sq);

        const answersList: string[] = [];
        survey.builderResponses.forEach((resp) => {
          const ansObj = resp.answers as Record<string, unknown>;
          if (ansObj && typeof ansObj[sq.id] === 'string') {
            answersList.push(ansObj[sq.id] as string);
          }
        });

        const colors = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

        if (dto.answerType === "select" || dto.answerType === "boolean") {
          const options: string[] = dto.answerOptions ?? (dto.answerType === "boolean" ? ["Yes", "No"] : ["Don't know"]);

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
            questionId: dto.questionCode ?? dto.id,
            questionText: dto.questionText,
            answerType: dto.answerType,
            slices
          };
        }

        if (dto.answerType === "numeric") {
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
            questionId: dto.questionCode ?? dto.id,
            questionText: dto.questionText,
            answerType: dto.answerType,
            slices
          };
        }

        return {
          questionId: dto.questionCode ?? dto.id,
          questionText: dto.questionText,
          answerType: dto.answerType,
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
