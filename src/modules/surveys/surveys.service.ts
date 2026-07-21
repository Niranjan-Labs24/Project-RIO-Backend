import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore, requireActor, requireOrgId } from '../../tenancy/org-context';
import { roleByKey } from '../../rbac/role-matrix';
import { AuditService } from '../audit/audit.service';
import { AiService } from '../ai/ai.service';
import { MethodologyConfigService } from '../methodology-config/methodology-config.service';

@Injectable()
export class SurveysService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly ai: AiService,
    private readonly methodologyConfig: MethodologyConfigService,
  ) {}

  // Survey creation (empty or AI-recommended) stays gated on the Need
  // having gone through a *reviewed and approved* AI Classification — not
  // just having a Domain Category. The Domain Category is now set manually
  // at Need creation (always present), so domain-presence alone stopped
  // being a meaningful gate; the Need's own status is what actually proves
  // AI Classification was run and a human signed off on it (see
  // AiDecisionsService.review, which is the only thing that moves a Need
  // to `reviewer_approved`). `survey_created`/`survey_published` are later
  // stages that already passed through `reviewer_approved` on the way, so
  // they're allowed too (recommendQuestions can regenerate AI suggestions
  // for an existing DRAFT/REJECTED survey).
  private assertClassificationApproved(status: string): void {
    const approved = status === 'reviewer_approved' || status === 'survey_created' || status === 'survey_published';
    if (!approved) {
      throw new ConflictException({
        error: {
          code: 'AI_CLASSIFICATION_NOT_APPROVED',
          message: 'This need requires a reviewed and approved AI Classification before a survey can be created.',
        },
      });
    }
  }

  // The shared AuditLog table has no dedicated role column (see
  // AuditService) — every action across the whole app is missing this by
  // default. The Survey Approval workflow's audit trail is explicitly
  // required to carry the actor's role, so it's captured here as metadata
  // (the one field AuditService already passes through untouched) rather
  // than widening the shared schema for one feature.
  private actorRoleMetadata(): Record<string, unknown> {
    const roleKey = getOrgStore()?.role;
    const role = roleKey ? roleByKey(roleKey) : undefined;
    return role ? { actorRole: role.key, actorRoleName: role.name } : {};
  }

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
  async getPublishedSurveyByNeedId(needId: string) {
    return this.tenant.runAsSupervisor(async (tx) => {
      const survey = await tx.survey.findFirst({
        where: { needId, status: 'PUBLISHED' },
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
        needId: survey.needId,
        studyId: survey.studyId,
        title: survey.title,
        status: survey.status,
        methodologyVersion: survey.methodologyVersion,
        questions: survey.surveyQuestions.map((sq) => this.toQuestionDto(sq)),
      };
    });
  }

  async getSurveyByNeedId(needId: string) {
    const row = await this.tenant.runInOrgContext(async (tx) => {
      const survey = await tx.survey.findFirst({
        where: { needId },
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
    return this.toSurveyDetailDto(row);
  }

  private async toSurveyDetailDto(row: {
    id: string; needId: string; studyId: string; title: string; status: string;
    methodologyVersion: string | null;
    submittedAt: Date | null;
    approverComments: string | null;
    approvedAt: Date | null; approvedBy: string | null;
    rejectedAt: Date | null; rejectedBy: string | null;
    publishedAt: Date | null; publishedBy: string | null;
    surveyQuestions: Parameters<SurveysService['toQuestionDto']>[0][];
  }) {
    const names = await this.resolveUserNames(
      [row.approvedBy, row.rejectedBy, row.publishedBy].filter((id): id is string => id !== null),
    );
    return {
      id: row.id,
      needId: row.needId,
      studyId: row.studyId,
      title: row.title,
      status: row.status,
      methodologyVersion: row.methodologyVersion,
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      approverComments: row.approverComments,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      approvedBy: row.approvedBy,
      approvedByName: row.approvedBy ? (names.get(row.approvedBy) ?? null) : null,
      rejectedAt: row.rejectedAt ? row.rejectedAt.toISOString() : null,
      rejectedBy: row.rejectedBy,
      rejectedByName: row.rejectedBy ? (names.get(row.rejectedBy) ?? null) : null,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      publishedBy: row.publishedBy,
      publishedByName: row.publishedBy ? (names.get(row.publishedBy) ?? null) : null,
      questions: row.surveyQuestions.map((sq) => this.toQuestionDto(sq)),
    };
  }

  private async resolveUserNames(userIds: string[]): Promise<Map<string, string>> {
    const distinctIds = [...new Set(userIds)];
    if (distinctIds.length === 0) return new Map();
    const users = await this.tenant.runInOrgContext((tx) =>
      tx.user.findMany({ where: { id: { in: distinctIds } }, select: { id: true, name: true } }),
    );
    return new Map(users.map((u) => [u.id, u.name]));
  }

  // "Build Manually" path: Create Survey without calling Gemini — a bare
  // DRAFT survey with no questions yet, so the Survey Builder page has
  // something to attach questions to via its existing add-from-Question-Bank
  // combobox. Idempotent: if a survey already exists for this study (e.g.
  // AI suggestions were generated first, or this was already called), just
  // return it rather than wiping its questions.
  async createEmptySurvey(needId: string): Promise<any> {
    const orgId = requireOrgId();
    const actorId = requireActor();

    const { survey, created } = await this.tenant.runInOrgContext(async (tx) => {
      const need = await tx.need.findUnique({ where: { id: needId } });
      if (!need) {
        throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      }
      if (!need.domain || !need.subDomain) {
        throw new BadRequestException({
          error: { code: 'NO_APPROVED_DOMAIN', message: 'This need requires a Domain Category before generating a survey.' },
        });
      }
      this.assertClassificationApproved(need.status);

      const existing = await tx.survey.findFirst({ where: { needId } });
      if (existing) return { survey: existing, created: false };

      const row = await tx.survey.create({
        data: { orgId, needId, studyId: need.studyId, title: `Survey: ${need.title}`, status: 'DRAFT', createdBy: actorId },
      });
      await tx.need.update({ where: { id: needId }, data: { status: 'survey_created' } });
      return { survey: row, created: true };
    });

    if (created) {
      await this.audit.record({
        action: 'create',
        entityType: 'survey',
        entityId: survey.id,
        entityLabel: `Manually created ${survey.title}`,
      });
    }

    return this.getSurveyByNeedId(needId);
  }

  async recommendQuestions(needId: string): Promise<any> {
    const orgId = requireOrgId();
    const actorId = requireActor();

    const data = await this.tenant.runInOrgContext(async (tx) => {
      const need = await tx.need.findUnique({ where: { id: needId } });
      if (!need) {
        throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      }
      if (!need.domain || !need.subDomain) {
        throw new BadRequestException({
          error: { code: 'NO_APPROVED_DOMAIN', message: 'This need requires a Domain Category before generating a survey.' },
        });
      }
      this.assertClassificationApproved(need.status);
      // Once published, a survey may already have live citizen responses —
      // re-running AI recommendation would otherwise silently delete and
      // replace its Question Bank items out from under them (see the
      // deleteMany/createMany below). Checked before the Gemini call so a
      // doomed request fails fast rather than burning an AI call first.
      // SUBMITTED is blocked too — same reason updateQuestions is: the
      // Approver reviews exactly what was submitted, not a moving target.
      const existingSurvey = await tx.survey.findFirst({ where: { needId } });
      if (existingSurvey?.status === 'PUBLISHED' || existingSurvey?.status === 'SUBMITTED') {
        throw new ConflictException({
          error: {
            code: existingSurvey.status === 'PUBLISHED' ? 'SURVEY_ALREADY_PUBLISHED' : 'SURVEY_NOT_EDITABLE',
            message:
              existingSurvey.status === 'PUBLISHED'
                ? 'This survey is already published and its questions can no longer be regenerated.'
                : 'This survey is awaiting approval and its questions cannot be regenerated until it is reviewed.',
          },
        });
      }

      const eligibleQuestions = await tx.question.findMany({
        where: { domain: need.domain, subDomain: need.subDomain, usedInMvp: true },
      });

      return { need, eligibleQuestions };
    });

    const { need, eligibleQuestions } = data;
    if (eligibleQuestions.length === 0) {
      throw new ConflictException({
        error: { code: 'NO_ELIGIBLE_QUESTIONS', message: 'No questions found in this domain/subdomain' },
      });
    }

    const systemInstruction = `You are a survey question recommendation assistant. You must recommend only question IDs from the provided eligible questions list. Do not create new question text. Do not edit question text. Return valid JSON only.`;

    const prompt = `Need Statement: "${need.statement}"
Approved Domain: "${need.domain}"
Approved SubDomain: "${need.subDomain}"
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
    await this.tenant.runInOrgContext(async (tx) =>
      tx.aiSuggestion.create({
        data: {
          orgId,
          needId,
          studyId: need.studyId,
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
      let existingSurvey = await tx.survey.findFirst({ where: { needId } });
      if (!existingSurvey) {
        existingSurvey = await tx.survey.create({
          data: {
            orgId,
            needId,
            studyId: need.studyId,
            title: `Survey: ${need.title}`,
            status: 'DRAFT',
            createdBy: actorId,
          },
        });
        await tx.need.update({ where: { id: needId }, data: { status: 'survey_created' } });
      } else {
        existingSurvey = await tx.survey.update({
          where: { id: existingSurvey.id },
          data: { title: `Survey: ${need.title}` },
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
      entityLabel: `AI recommended questions for ${survey.title}`,
    });

    return this.getSurveyByNeedId(needId);
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

    const needId = await this.tenant.runInOrgContext(async (tx) => {
      const survey = await tx.survey.findUnique({ where: { id: surveyId } });
      if (!survey) {
        throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
      }
      this.assertEditable(survey.status);

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

      return survey.needId;
    });

    await this.audit.record({
      action: 'edit',
      entityType: 'survey',
      entityId: surveyId,
      entityLabel: `Survey questions updated manually`,
    });

    return this.getSurveyByNeedId(needId);
  }

  // Content (questions, Methodology Version) is frozen the moment a survey
  // is SUBMITTED — the Approver reviews exactly what was submitted, never a
  // moving target. Same rule once PUBLISHED (terminal). Editing resumes
  // only after a REJECTED verdict, or from DRAFT.
  private assertEditable(status: string): void {
    if (status === 'SUBMITTED' || status === 'PUBLISHED') {
      throw new ConflictException({
        error: {
          code: 'SURVEY_NOT_EDITABLE',
          message:
            status === 'SUBMITTED'
              ? 'This survey is awaiting approval and cannot be edited until it is reviewed.'
              : 'This survey is already published and can no longer be edited.',
        },
      });
    }
  }

  // Researcher: picks the Methodology Version this survey will publish
  // under — mandatory before submitForApproval will allow SUBMITTED (see
  // below). The Approver never calls this; they only review/publish
  // whatever the Researcher already chose (approveAndPublish doesn't touch
  // this field at all).
  async setMethodologyVersion(surveyId: string, version: string) {
    const options = await this.methodologyConfig.listVersionOptions();
    if (!options.some((o) => o.version === version)) {
      throw new BadRequestException({
        error: { code: 'INVALID_METHODOLOGY_VERSION', message: 'Select a valid Methodology Version from the list.' },
      });
    }

    const needId = await this.tenant.runInOrgContext(async (tx) => {
      const survey = await tx.survey.findUnique({ where: { id: surveyId } });
      if (!survey) {
        throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
      }
      this.assertEditable(survey.status);
      await tx.survey.update({ where: { id: surveyId }, data: { methodologyVersion: version } });
      return survey.needId;
    });

    await this.audit.record({
      action: 'edit',
      entityType: 'survey',
      entityId: surveyId,
      entityLabel: `Methodology Version set to "${version}"`,
      metadata: this.actorRoleMetadata(),
    });

    return this.getSurveyByNeedId(needId);
  }

  // ──────── Survey Approval workflow ────────
  // Draft --[Researcher: submitForApproval]--> Submitted
  //   --[Approver: approveAndPublish]--> Published (terminal)
  //   --[Approver: rejectSurvey]--> Rejected
  //      --[Researcher: edits (updateQuestions), then submitForApproval]--> Submitted (again)
  // The Approver is never a co-author — approveAndPublish/rejectSurvey never
  // touch surveyQuestions; the only way survey content changes is through
  // updateQuestions, which the Researcher (surveyBuilder/write) calls, and
  // which is itself blocked while SUBMITTED or PUBLISHED (see above).

  // Researcher: hands the current content to the Approver. Valid from DRAFT
  // (first submission) or REJECTED (resubmission after addressing
  // comments) — never creates a new Survey row, this is the same one
  // throughout its whole review history.
  async submitForApproval(surveyId: string) {
    const survey = await this.tenant.runInOrgContext((tx) => tx.survey.findUnique({ where: { id: surveyId } }));
    if (!survey) {
      throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
    }
    if (survey.status !== 'DRAFT' && survey.status !== 'REJECTED') {
      throw new ConflictException({
        error: { code: 'SURVEY_NOT_SUBMITTABLE', message: 'Only a draft or rejected survey can be submitted for approval.' },
      });
    }
    // Same "nothing for a citizen to answer" guard publishing already had —
    // still applies, just moved one step earlier in the flow.
    const questionCount = await this.tenant.runInOrgContext((tx) => tx.surveyQuestion.count({ where: { surveyId } }));
    if (questionCount === 0) {
      throw new BadRequestException({
        error: { code: 'SURVEY_HAS_NO_QUESTIONS', message: 'Add at least one question before submitting this survey for approval.' },
      });
    }
    // The Researcher picks the Methodology Version (setMethodologyVersion,
    // while the survey is still editable) before submitting — the Approver
    // never chooses or changes it, only reviews/publishes whatever's
    // already here (see approveAndPublish, which no longer touches this
    // field at all).
    if (!survey.methodologyVersion) {
      throw new BadRequestException({
        error: { code: 'SURVEY_NO_METHODOLOGY_VERSION', message: 'Select a Methodology Version before submitting this survey for approval.' },
      });
    }

    const updated = await this.tenant.runInOrgContext((tx) =>
      tx.survey.update({
        where: { id: surveyId },
        data: {
          status: 'SUBMITTED',
          submittedAt: new Date(),
          // Clear the previous round's feedback — once resubmitted, that
          // note no longer describes the current pending state. The audit
          // log still has the full history regardless.
          approverComments: null,
          rejectedAt: null,
          rejectedBy: null,
        },
      }),
    );

    await this.audit.record({
      action: 'edit',
      entityType: 'survey',
      entityId: surveyId,
      entityLabel: 'Survey submitted for approval',
      metadata: this.actorRoleMetadata(),
    });

    return updated;
  }

  // Approver: the only path to PUBLISHED. Combines "approve" and "publish"
  // into one action per the product decision — there's no intermediate
  // "approved but not yet published" state.
  async approveAndPublish(surveyId: string) {
    const survey = await this.tenant.runInOrgContext((tx) => tx.survey.findUnique({ where: { id: surveyId } }));
    if (!survey) {
      throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
    }
    if (survey.status !== 'SUBMITTED') {
      throw new ConflictException({
        error: { code: 'SURVEY_NOT_PENDING_APPROVAL', message: 'This survey is not currently awaiting approval.' },
      });
    }

    const actorId = requireActor();
    const now = new Date();

    // methodologyVersion is deliberately NOT touched here — it's whatever
    // the Researcher already chose via setMethodologyVersion before
    // submitting (submitForApproval requires it to be set). The Approver
    // reviews and publishes exactly that choice; they never select or
    // change it themselves.
    const updated = await this.tenant.runInOrgContext(async (tx) => {
      const row = await tx.survey.update({
        where: { id: surveyId },
        data: {
          status: 'PUBLISHED',
          approvedAt: now,
          approvedBy: actorId,
          publishedAt: now,
          publishedBy: actorId,
        },
      });
      await tx.need.update({ where: { id: survey.needId }, data: { status: 'survey_published' } });
      return row;
    });

    await this.audit.record({
      action: 'approve',
      entityType: 'survey',
      entityId: surveyId,
      entityLabel: 'Survey approved and published',
      metadata: this.actorRoleMetadata(),
    });

    return updated;
  }

  // Approver: sends the survey back to the Researcher with required
  // comments. Never touches surveyQuestions — any content change has to
  // come from the Researcher through updateQuestions after this.
  async rejectSurvey(surveyId: string, comments: string) {
    const survey = await this.tenant.runInOrgContext((tx) => tx.survey.findUnique({ where: { id: surveyId } }));
    if (!survey) {
      throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
    }
    if (survey.status !== 'SUBMITTED') {
      throw new ConflictException({
        error: { code: 'SURVEY_NOT_PENDING_APPROVAL', message: 'This survey is not currently awaiting approval.' },
      });
    }

    const actorId = requireActor();
    const updated = await this.tenant.runInOrgContext((tx) =>
      tx.survey.update({
        where: { id: surveyId },
        data: {
          status: 'REJECTED',
          rejectedAt: new Date(),
          rejectedBy: actorId,
          approverComments: comments,
        },
      }),
    );

    await this.audit.record({
      action: 'edit',
      entityType: 'survey',
      entityId: surveyId,
      entityLabel: 'Survey rejected',
      changes: [{ field: 'Approver Comments', before: null, after: comments }],
      metadata: this.actorRoleMetadata(),
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
