import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { Prisma, RejectionReasonCode } from '../../generated/prisma';
import { getOrgStore, requireActor, requireOrgId } from '../../tenancy/org-context';
import { roleByKey } from '../../rbac/role-matrix';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import { AiService } from '../ai/ai.service';
import { SURVEY_QUESTION_RECOMMENDATION_TASK } from '../ai/prompts/survey-question-recommendation.task';
import { MethodologyConfigService } from '../methodology-config/methodology-config.service';
import { requireNonBlank } from '../../common/validation/require-non-blank';

@Injectable()
export class SurveysService {
  // TEMP diagnostic logging (RIO-debug: research-officer override ->
  // Question Bank tab not showing new sub-domain's questions) — remove once
  // root cause is confirmed.
  private readonly logger = new Logger(SurveysService.name);

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
  private toQuestionDto(
    sq: {
      id: string;
      order: number;
      isRequired: boolean;
      customText: string | null;
      customAnswerType: string | null;
      customOptions: unknown;
      domain: string | null;
      subDomain: string | null;
      kpi: string | null;
      question: {
        id: string;
        questionId: string;
        questionText: string;
        answerType: string;
        answerOptions: unknown;
        domain: string;
        subDomain: string;
        indicator: string | null;
        kpi: string | null;
        priorityWeight?: Prisma.Decimal | null;
      } | null;
    },
    // RIO-AI-002: the Domain → Indicator → KPI → Weight linkage is an
    // internal Survey Builder concern (Research Officer/Reviewer curating
    // the questionnaire) — deliberately NOT included in the citizen-facing
    // DTO (getPublishedSurveyByNeedId never passes this), so a public
    // survey-response payload never leaks methodology weight values.
    includeWeight = false,
  ) {
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
        domain: sq.question.domain,
        subDomain: sq.question.subDomain,
        indicator: sq.question.indicator,
        kpi: sq.question.kpi,
        priorityWeight: includeWeight ? (sq.question.priorityWeight?.toNumber() ?? null) : undefined,
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
      // Null for a custom question saved before this field existed — see
      // the migration/contract comments. Not backfilled; just unset until
      // someone edits it again through the dialog.
      domain: sq.domain,
      subDomain: sq.subDomain,
      indicator: null,
      kpi: sq.kpi,
      // A custom question has no Question Bank row, so no weight — kept as
      // an explicit key (not omitted) so both branches share one shape.
      priorityWeight: undefined,
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
      // RIO-FR-011: a Need can have more than one PUBLISHED survey row once
      // a version is superseded (the old version keeps its own PUBLISHED
      // status forever — see createNewVersion) — `version: 'desc'` picks the
      // one actually collecting responses right now.
      const survey = await tx.survey.findFirst({
        where: { needId, status: 'PUBLISHED' },
        orderBy: { version: 'desc' },
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
      // RIO-FR-011: multiple versions can exist for one Need once at least
      // one has been superseded (see createNewVersion) — always resolve to
      // the latest version for Survey Builder/management screens.
      const survey = await tx.survey.findFirst({
        where: { needId },
        orderBy: { version: 'desc' },
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

  // Org-scoped counterpart to getPublishedSurveyByNeedId (which runs
  // cross-org for the citizen flow) — this is what internal screens that
  // display "the currently live survey" (Response Summary, the public
  // survey link's status) must call instead of getSurveyByNeedId. Once a
  // DRAFT v2 exists, getSurveyByNeedId's "latest version" resolution starts
  // returning v2 even though v1 is still the one actually collecting
  // responses; that mismatch is what made a still-published v1 look
  // unpublished/empty in those screens (RIO-FR-011 regression).
  async getPublishedSurveyForOrgByNeedId(needId: string) {
    const row = await this.tenant.runInOrgContext(async (tx) => {
      const survey = await tx.survey.findFirst({
        where: { needId, status: 'PUBLISHED' },
        orderBy: { version: 'desc' },
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

  // Every survey version ever created for a Need, each labeled with how
  // many of the Need's responses actually belong to it. A SurveyResponse
  // isn't tagged with a survey/version id directly — its `answers` JSON is
  // keyed by whichever version's SurveyQuestion ids were live at submission
  // (see buildQuestionMap's comment in public-surveys.service.ts for the
  // same fact from the other side) — so membership is derived by checking
  // which version's question-id set a response's answer keys land in.
  async listSurveyVersionsByNeedId(needId: string) {
    return this.tenant.runInOrgContext(async (tx) => {
      const [surveys, responses] = await Promise.all([
        tx.survey.findMany({
          where: { needId },
          orderBy: { version: 'asc' },
          include: { surveyQuestions: { select: { id: true } } },
        }),
        tx.surveyResponse.findMany({ where: { needId }, select: { answers: true } }),
      ]);
      return surveys.map((survey) => {
        const questionIds = new Set(survey.surveyQuestions.map((sq) => sq.id));
        const responseCount = responses.filter((r) => {
          const rawAnswers = (r.answers ?? {}) as Record<string, unknown>;
          return Object.keys(rawAnswers).some((id) => questionIds.has(id));
        }).length;
        return {
          id: survey.id,
          version: survey.version,
          status: survey.status,
          title: survey.title,
          responseCount,
        };
      });
    });
  }

  // Both callers (getSurveyByNeedId, getPublishedSurveyForOrgByNeedId) are
  // org-scoped Survey Builder / management screens, never the citizen flow
  // (see getPublishedSurveyByNeedId/getPublicSurvey below for that) — so
  // this always surfaces weight, per RIO-AI-002's Domain → Indicator →
  // Weight linkage requirement.
  private async toSurveyDetailDto(row: {
    id: string; needId: string; studyId: string; title: string; status: string;
    methodologyVersion: string | null;
    version: number; previousVersionId: string | null;
    targetGroup: string | null;
    expectedSampleSize: number | null;
    selectionApproach: string | null;
    geographicCoverage: string | null;
    submittedAt: Date | null;
    approverComments: string | null;
    rejectionReasonCode: RejectionReasonCode | null;
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
      version: row.version,
      previousVersionId: row.previousVersionId,
      targetGroup: row.targetGroup,
      expectedSampleSize: row.expectedSampleSize,
      selectionApproach: row.selectionApproach,
      geographicCoverage: row.geographicCoverage,
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      approverComments: row.approverComments,
      rejectionReasonCode: row.rejectionReasonCode,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      approvedBy: row.approvedBy,
      approvedByName: row.approvedBy ? (names.get(row.approvedBy) ?? null) : null,
      rejectedAt: row.rejectedAt ? row.rejectedAt.toISOString() : null,
      rejectedBy: row.rejectedBy,
      rejectedByName: row.rejectedBy ? (names.get(row.rejectedBy) ?? null) : null,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      publishedBy: row.publishedBy,
      publishedByName: row.publishedBy ? (names.get(row.publishedBy) ?? null) : null,
      questions: row.surveyQuestions.map((sq) => this.toQuestionDto(sq, true)),
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
  async createEmptySurvey(needId: string) {
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

      // RIO-FR-011: a Need can have more than one Survey row now
      // (versioning) — always resolve to the latest version.
      const existing = await tx.survey.findFirst({ where: { needId }, orderBy: { version: 'desc' } });
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
        // before: null on a create — records the survey's opening state so
        // the audit detail view is not blank for created events.
        changes: [
          { field: 'Title', before: null, after: survey.title },
          { field: 'Status', before: null, after: survey.status },
        ],
      });
    }

    return this.getSurveyByNeedId(needId);
  }

  // Custom (open-ended) questions a Research Officer previously typed in
  // from scratch on some OTHER survey, for this exact Domain/Sub-domain —
  // lets a later survey targeting the same Domain/Sub-domain reuse one
  // instead of recreating it. Deliberately org-wide (not scoped to one
  // Need/Survey) and filtered to the current Need's own Domain/Sub-domain
  // when one is known. `domain`/`subDomain` both omitted means "AI couldn't
  // classify this Need at all" (allDomainsSelected) — the same "match
  // every eligible question" convention getQuestions([]) already uses for
  // the Question Bank tab, so the Custom Questions tab isn't left empty
  // just because there's no single domain to filter by. Deduped by question
  // text (case/whitespace-insensitive) since the same wording can easily
  // have been reused across several surveys already; the most recently
  // created copy wins the dedupe so answerType/options reflect its latest
  // form.
  async listReusableCustomQuestions(domain?: string, subDomain?: string) {
    const rows = await this.tenant.runInOrgContext((tx) =>
      tx.surveyQuestion.findMany({
        where: domain && subDomain ? { customText: { not: null }, domain, subDomain } : { customText: { not: null } },
        orderBy: { id: 'desc' },
        include: { survey: { select: { title: true } } },
      }),
    );

    const seen = new Set<string>();
    const deduped: typeof rows = [];
    for (const row of rows) {
      const key = (row.customText ?? '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(row);
    }

    return deduped.map((row) => ({
      id: row.id,
      questionText: row.customText ?? '',
      answerType: row.customAnswerType ?? 'long_text',
      answerOptions:
        typeof row.customOptions === 'string' ? JSON.parse(row.customOptions) : (row.customOptions ?? null),
      domain: row.domain,
      subDomain: row.subDomain,
      kpi: row.kpi,
      sourceSurveyTitle: row.survey.title,
    }));
  }

  // Public, manual "regenerate" entry point — used by the Researcher's
  // legacy "Create Survey > Generate AI Suggestions" dialog. No override is
  // ever passed in from the controller (it never accepted a body) — this
  // always regenerates from whatever's already known about the Need: its
  // real, multi-valued NeedDomain rows if any exist (an already-approved
  // multi-domain Need), else "every active domain" if allDomainsSelected,
  // else the single Approved Domain/AI-suggested pair, in that order.
  async recommendQuestions(needId: string) {
    const { need, needDomains } = await this.tenant.runInOrgContext(async (tx) => {
      const need = await tx.need.findUnique({ where: { id: needId } });
      if (!need) {
        throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      }
      const needDomains = await tx.needDomain.findMany({ where: { needId } });
      return { need, needDomains };
    });
    if (needDomains.length > 0) {
      return this.generateSuggestedQuestions(
        needId,
        needDomains.map((d) => ({ domain: d.domain, subDomain: d.subDomain })),
      );
    }
    if (need.allDomainsSelected) {
      return this.generateSuggestedQuestions(needId, []);
    }
    const domain = need.domain ?? need.aiSuggestedDomain;
    const subDomain = need.subDomain ?? need.aiSuggestedSubDomain;
    if (!domain || !subDomain) {
      throw new BadRequestException({
        error: { code: 'NO_APPROVED_DOMAIN', message: 'This need has no Domain/Sub-Domain to generate questions from yet.' },
      });
    }
    return this.generateSuggestedQuestions(needId, [{ domain, subDomain }]);
  }

  // Core question-suggestion logic, shared by:
  //  - AiDecisionsService.runAndPersistClassification, called automatically
  //    right after classification succeeds, before any human has reviewed it;
  //  - AiDecisionsService.manualClassify;
  //  - the manual recommendQuestions() entry point above;
  //  - the AI Review screen's Override-Domain preview
  //    (AiDecisionsService.overrideDomainPreview), re-run against candidate
  //    pairs the Approver hasn't committed to yet.
  // `pairs` is empty exactly when the Need is allDomainsSelected (AI
  // couldn't classify it into anything specific) — in that case every
  // active Question Bank entry is eligible, with no domain/subDomain filter
  // at all, rather than iterating every real Domain/Sub-domain combination.
  // Deliberately NOT gated on Need-approval status (classification hasn't
  // been reviewed yet the first time this runs) and does NOT write any
  // Need-status transition of its own — only Survey/SurveyQuestion/
  // AiSuggestion rows. Idempotent: always reuses an existing DRAFT Survey
  // for this Need rather than creating a second one (Retry/regeneration
  // make hitting this path far more common than before).
  async generateSuggestedQuestions(
    needId: string,
    pairs: Array<{ domain: string; subDomain: string }>,
    options: { allowWhileSubmitted?: boolean } = {},
  ) {
    const orgId = requireOrgId();
    const actorId = requireActor();
    const domainLabel = pairs.length > 0 ? pairs.map((p) => `${p.domain} / ${p.subDomain}`).join(', ') : 'All Domains';

    const data = await this.tenant.runInOrgContext(async (tx) => {
      const need = await tx.need.findUnique({ where: { id: needId }, include: { study: { select: { studyType: true } } } });
      if (!need) {
        throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
      }
      // Once published, a survey may already have live citizen responses —
      // re-running AI recommendation would otherwise silently delete and
      // replace its Question Bank items out from under them (see the
      // deleteMany/createMany below). Blocked for everyone, no exceptions.
      //
      // SUBMITTED is a moving-target concern only for the Researcher — they
      // shouldn't change the domain a Survey is being reviewed against out
      // from under the Approver. The Approver themselves is exactly who's
      // doing that review right now, so `allowWhileSubmitted` (set by
      // AiDecisionsService.overrideDomainPreview based on the caller's role)
      // lets them override while it's SUBMITTED — see
      // ai-classification-section.tsx's overrideDisabledForResearcher for
      // the matching frontend-side gate.
      // RIO-FR-011: resolve to the latest version — once a new DRAFT version
      // exists for a previously-published Need, this guard should govern
      // that draft, not the (now superseded-or-still-published) original.
      const existingSurvey = await tx.survey.findFirst({ where: { needId }, orderBy: { version: 'desc' } });
      if (existingSurvey?.status === 'PUBLISHED') {
        throw new ConflictException({
          error: {
            code: 'SURVEY_ALREADY_PUBLISHED',
            message: 'This survey is already published and its questions can no longer be regenerated.',
          },
        });
      }
      if (existingSurvey?.status === 'SUBMITTED' && !options.allowWhileSubmitted) {
        throw new ConflictException({
          error: {
            code: 'SURVEY_NOT_EDITABLE',
            message: 'This survey is awaiting approval and its questions cannot be regenerated until it is reviewed.',
          },
        });
      }

      // RIO-AI-005/RIO-AI-002: the AI may only ever suggest from the approved
      // bank of ONE methodology version — the draft survey's own snapshot if it
      // has one, else the latest PUBLISHED version (the same fallback the
      // scoring engine uses, so nothing can be recommended that scoring would
      // then fail to resolve). Unscoped, this spanned every imported bank at
      // once and could recommend a retired version's question.
      const mv = await tx.methodologyVersion.findFirst({
        where: existingSurvey?.methodologyVersion
          ? { version: existingSurvey.methodologyVersion }
          : { status: 'PUBLISHED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, version: true },
      });
      if (!mv) {
        throw new NotFoundException({
          error: {
            code: 'METHODOLOGY_VERSION_NOT_FOUND',
            message:
              'No published methodology version is configured yet. Import and publish the approved methodology baseline before building surveys.',
          },
        });
      }
      // isFielded excludes the 7 questionnaire-structure/roster/template modules
      // (XDM-01..07) — instrument scaffolding, never selectable questions.
      //
      // RIO-AI-002 (Sprint 2 clarification Q4) — Study Type filtering.
      // `need.study.studyType` is read and threaded through here so the
      // mechanism is wired end to end, but there is no filter clause below
      // yet: the client hasn't confirmed valid Study Type values or which
      // domains/questions each one should restrict, so there's nothing
      // correct to filter on yet. Once answered, add a `studyType`-based
      // condition to this `where` (or a Question-side mapping) without
      // needing to touch any caller — they already pass the Study's
      // studyType down to this point.
      const studyType = need.study?.studyType ?? null;
      const eligibleQuestions = await tx.question.findMany({
        where: {
          methodologyVersionId: mv.id,
          usedInMvp: true,
          isFielded: true,
          ...(pairs.length > 0
            ? { OR: pairs.map((p) => ({ domain: p.domain, subDomain: p.subDomain })) }
            : {}),
        },
      });

      return { need, eligibleQuestions, mv, studyType };
    });

    const { need, eligibleQuestions, mv, studyType } = data;
    void studyType; // see the studyType comment above — read and passed through, not yet a live filter

    let recommendedQuestionIds: string[] = [];
    let confidence = 0;
    let reason = '';
    let raw: unknown = null;

    // Zero matching Question Bank rows for the given pair(s) (e.g. a
    // reference-data mismatch between the configured sub-domain name and
    // the Question Bank's own domain/subDomain strings) must still produce
    // a Survey — just an empty one the Approver can fill from the Question
    // Bank tab (any domain) or with custom questions, rather than a hard
    // failure that silently leaves the Need with no Survey at all (see
    // AiDecisionsService.runAndPersistClassification's best-effort catch).
    if (eligibleQuestions.length === 0) {
      reason =
        `No Question Bank questions match ${domainLabel} — this survey was created with no recommended questions. Add questions from the Question Bank or as custom questions.`;
    } else {
      const prompt = `Need Statement: "${need.statement}"
Domain(s): "${domainLabel}"
Eligible Questions: ${JSON.stringify(
        eligibleQuestions.map((q) => ({
          questionId: q.questionId,
          questionText: q.questionText,
          answerType: q.answerType,
          answerOptions: typeof q.answerOptions === 'string' ? JSON.parse(q.answerOptions) : q.answerOptions,
          indicator: q.indicator,
          kpi: q.kpi,
          // RIO-AI-002: surfaced so the recommendation reasoning can factor
          // in a question's weight, and so the Domain → Indicator → KPI →
          // Weight linkage the story requires is available end to end —
          // the value itself already lived on Question, just wasn't read
          // here or exposed to the Survey Builder UI before this.
          priorityWeight: q.priorityWeight,
        })),
      )}`;

      try {
        const result = await this.ai.run(SURVEY_QUESTION_RECOMMENDATION_TASK, prompt);
        recommendedQuestionIds = result.response.recommendedQuestionIds || [];
        confidence = result.response.confidence || 0;
        reason = result.response.reason || '';
        raw = result.raw;
      } catch (err) {
        // Question suggestion must never leave the Need with nothing to show
        // an Approver — if Gemini is unavailable, fall back to every eligible
        // Question Bank entry for this domain/subDomain rather than throwing.
        recommendedQuestionIds = eligibleQuestions.map((q) => q.questionId);
        confidence = 0;
        const message = err instanceof Error ? err.message : String(err);
        reason = `AI question recommendation was unavailable (${message}) — showing all eligible Question Bank questions for ${domainLabel} instead.`;
      }
    }

    // Validate recommended questions exist in DB and match the criteria
    const validatedQuestions = eligibleQuestions.filter((q) =>
      recommendedQuestionIds.includes(q.questionId),
    );

    // If validation results in 0 questions, use all eligible questions as fallback
    const finalQuestions = validatedQuestions.length > 0 ? validatedQuestions : eligibleQuestions;

    // Log AI Suggestion — the "suggested, as opposed to approved" snapshot.
    // Never touched again after this; whatever the Approver leaves in
    // SurveyQuestion at Approve time is the separate, approved set.
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
          rawResponse: raw as Prisma.InputJsonValue,
          createdBy: actorId,
        },
      }),
    );

    // Create-or-update, never a second Survey row for the same Need.
    const survey = await this.tenant.runInOrgContext(async (tx) => {
      let existingSurvey = await tx.survey.findFirst({ where: { needId }, orderBy: { version: 'desc' } });
      if (!existingSurvey) {
        existingSurvey = await tx.survey.create({
          data: {
            orgId,
            needId,
            studyId: need.studyId,
            title: `Survey: ${need.title}`,
            status: 'DRAFT',
            createdBy: actorId,
            methodologyVersion: mv?.version ?? null,
          },
        });
      } else {
        existingSurvey = await tx.survey.update({
          where: { id: existingSurvey.id },
          data: { title: `Survey: ${need.title}` },
        });
      }

      // Recreate only the Question Bank links — any additional/open-ended
      // questions already on this survey (customText set, questionId null)
      // are left untouched, since they're the Researcher's own additions,
      // not something regenerated suggestions should ever wipe out.
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
      changes: [
        { field: 'Title', before: null, after: survey.title },
        { field: 'Status', before: null, after: survey.status },
        { field: 'Origin', before: null, after: 'AI-recommended questions' },
      ],
    });

    const result = await this.getSurveyByNeedId(needId);
    return result;
  }

  async updateQuestions(
    surveyId: string,
    questions: Array<{
      id?: string;
      questionId?: string;
      customText?: string;
      customAnswerType?: string;
      customOptions?: string[];
      domain?: string;
      subDomain?: string;
      kpi?: string;
      order: number;
      isRequired: boolean;
    }>,
    removalReasons: Record<string, string> = {},
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

    // The Researcher can't keep editing a SUBMITTED survey out from under
    // whoever's reviewing it, but the Approver themselves is exactly who's
    // doing that review — they curate the question list (add/remove/
    // reorder/custom) right up to Approve & Publish or Reject. Same role
    // split as overrideDomainPreview/generateSuggestedQuestions.
    const allowWhileSubmitted = getOrgStore()?.role !== 'ngo_research_officer';
    // Assigned inside the transaction, read by the audit record after it commits.
    let previousQuestionCount = 0;
    let removedForAudit: Array<{ label: string; reason: string }> = [];
    const needId = await this.tenant.runInOrgContext(async (tx) => {
      const survey = await tx.survey.findUnique({ where: { id: surveyId } });
      if (!survey) {
        throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
      }
      this.assertEditable(survey.status, allowWhileSubmitted);

      // Re-create the links using the incoming array — the whole ordered
      // list (Question Bank + additional questions together) is the unit of
      // save, per the Survey Builder's single Save action.
      const existing = await tx.surveyQuestion.findMany({
        where: { surveyId },
        include: { question: { select: { questionText: true } } },
      });
      // Counted before the wholesale delete below, for the audit pair.
      previousQuestionCount = existing.length;

      // Client-confirmed (Aug 13 call): a question the Reviewer removes
      // during their review must carry a reason. Scoped to SUBMITTED only —
      // that's precisely the Approver's curation window (see
      // allowWhileSubmitted above); the Researcher's own DRAFT-phase
      // editing never requires one. Removed = an existing row whose id
      // isn't carried through in the incoming array (a newly-added item
      // never has an `id` at all, so it can never look like a removal).
      if (survey.status === 'SUBMITTED') {
        const incomingIds = new Set(questions.map((q) => q.id).filter((id): id is string => Boolean(id)));
        const removed = existing.filter((sq) => !incomingIds.has(sq.id));
        const missingReason = removed.find((sq) => !removalReasons[sq.id]?.trim());
        if (missingReason) {
          throw new BadRequestException({
            error: {
              code: 'REMOVAL_REASON_REQUIRED',
              message: 'Give a reason for each question removed during review.',
            },
          });
        }
        removedForAudit = removed.map((sq) => ({
          label: sq.question?.questionText ?? sq.customText ?? 'Untitled question',
          // Already validated non-blank above (missingReason check) — the
          // `?? ''` here is just to satisfy the Record's `string | undefined`
          // index type, never actually reached empty.
          reason: removalReasons[sq.id] ?? '',
        }));
      }

      await tx.surveyQuestion.deleteMany({ where: { surveyId } });
      await tx.surveyQuestion.createMany({
        data: questions.map((q) => ({
          surveyId,
          questionId: q.questionId ?? null,
          customText: q.customText ?? null,
          customAnswerType: q.questionId ? null : (q.customAnswerType ?? 'long_text'),
          customOptions: q.questionId ? undefined : (q.customOptions ?? undefined),
          // Question Bank items resolve Domain/Sub-domain/KPI via their
          // linked Question row instead — these three stay null for them,
          // same as customAnswerType/customOptions above. For a custom
          // item, null here just means it predates this field (see the
          // migration/contract comments) — not rejected, just displayed as
          // unset until someone edits it through the dialog again.
          domain: q.questionId ? null : (q.domain ?? null),
          subDomain: q.questionId ? null : (q.subDomain ?? null),
          kpi: q.questionId ? null : (q.kpi ?? null),
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
      // Question sets are lists, not scalar fields — the before/after pair is
      // the count, which is what a reviewer scans for ("did someone strip the
      // questionnaire down?"). The questions themselves live on the survey.
      // A removal reason (SUBMITTED-phase only, see above) gets its own
      // change entry per question, so it shows up in the same audit record
      // rather than needing a second lookup.
      changes: [
        { field: 'Question count', before: previousQuestionCount, after: questions.length },
        ...removedForAudit.map((r) => ({ field: `Removed: ${r.label}`, before: r.reason, after: null })),
      ],
    });

    return this.getSurveyByNeedId(needId);
  }

  // Content (questions, Methodology Version) is frozen the moment a survey
  // is SUBMITTED, for the Researcher — they shouldn't keep moving the
  // target out from under whoever's reviewing it. The Approver is exactly
  // who's reviewing it, so updateQuestions passes allowWhileSubmitted based
  // on the caller's role (see there) to let them curate questions right up
  // to their decision. setMethodologyVersion below never passes it — the
  // Approver only ever reviews/publishes whatever Methodology Version the
  // Researcher already chose, they don't change it. PUBLISHED is always
  // terminal, for everyone, no exceptions — a live citizen-facing survey's
  // questions/version can never change post-publish.
  private assertEditable(status: string, allowWhileSubmitted = false): void {
    if (status === 'PUBLISHED') {
      throw new ConflictException({
        error: { code: 'SURVEY_NOT_EDITABLE', message: 'This survey is already published and can no longer be edited.' },
      });
    }
    // Client-confirmed (Aug 13 call): once the Approver has approved, the
    // Researcher just publishes — no editing window reopens in between, so
    // an add/remove-question round can't quietly restart the review cycle.
    // The only ways out of APPROVED are publishSurvey (below) or, if ever
    // needed, a fresh createNewVersion after publish.
    if (status === 'APPROVED') {
      throw new ConflictException({
        error: { code: 'SURVEY_NOT_EDITABLE', message: 'This survey is approved and ready to publish — it can no longer be edited.' },
      });
    }
    if (status === 'SUBMITTED' && !allowWhileSubmitted) {
      throw new ConflictException({
        error: { code: 'SURVEY_NOT_EDITABLE', message: 'This survey is awaiting approval and cannot be edited until it is reviewed.' },
      });
    }
  }

  // RIO-FR-011 (client-confirmed): the only way to change a PUBLISHED
  // survey's content — creates a new DRAFT version instead of editing in
  // place. The old (PUBLISHED) row's questions and every response already
  // attached to it are never touched — only its `status` moves, to
  // SUPERSEDED, once and only once the new version itself gets published
  // (see approveAndPublish below), so scoring/reporting/citizen-link
  // resolution keep their existing "exactly one PUBLISHED survey per need"
  // assumption. The new version starts as a copy of the old one's
  // questions/methodology/sample-description so the Researcher edits from a
  // known-good starting point rather than an empty survey.
  async createNewVersion(surveyId: string) {
    const actorId = requireActor();

    const { newSurveyId, needId } = await this.tenant.runInOrgContext(async (tx) => {
      const survey = await tx.survey.findUnique({
        where: { id: surveyId },
        include: { surveyQuestions: true },
      });
      if (!survey) {
        throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
      }
      if (survey.status !== 'PUBLISHED') {
        throw new ConflictException({
          error: {
            code: 'SURVEY_NOT_PUBLISHED',
            message: 'A new version can only be created from a published survey — this one is already editable directly.',
          },
        });
      }
      // previousVersionId is @unique — at most one newer version can point
      // back at this row. Don't silently create a second one; hand back the
      // one that already exists so the caller continues editing that.
      const existingNextVersion = await tx.survey.findUnique({ where: { previousVersionId: surveyId } });
      if (existingNextVersion) {
        return { newSurveyId: existingNextVersion.id, needId: survey.needId };
      }

      const created = await tx.survey.create({
        data: {
          orgId: survey.orgId,
          needId: survey.needId,
          studyId: survey.studyId,
          title: survey.title,
          status: 'DRAFT',
          methodologyVersion: survey.methodologyVersion,
          targetGroup: survey.targetGroup,
          expectedSampleSize: survey.expectedSampleSize,
          selectionApproach: survey.selectionApproach,
          geographicCoverage: survey.geographicCoverage,
          version: survey.version + 1,
          previousVersionId: survey.id,
          createdBy: actorId,
        },
      });
      if (survey.surveyQuestions.length > 0) {
        await tx.surveyQuestion.createMany({
          data: survey.surveyQuestions.map((sq) => ({
            surveyId: created.id,
            questionId: sq.questionId,
            customText: sq.customText,
            customAnswerType: sq.customAnswerType,
            customOptions: sq.customOptions as Prisma.InputJsonValue,
            domain: sq.domain,
            subDomain: sq.subDomain,
            kpi: sq.kpi,
            order: sq.order,
            isRequired: sq.isRequired,
          })),
        });
      }
      return { newSurveyId: created.id, needId: survey.needId };
    });

    await this.audit.record({
      action: 'create',
      entityType: 'survey',
      entityId: newSurveyId,
      entityLabel: `New survey version created from ${surveyId}`,
      metadata: this.actorRoleMetadata(),
      changes: [{ field: 'Previous version', before: null, after: surveyId }],
    });

    return this.getSurveyByNeedId(needId);
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

    const { needId, previousVersion } = await this.tenant.runInOrgContext(async (tx) => {
      const survey = await tx.survey.findUnique({ where: { id: surveyId } });
      if (!survey) {
        throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
      }
      this.assertEditable(survey.status);
      await tx.survey.update({ where: { id: surveyId }, data: { methodologyVersion: version } });
      // Read before the update overwrites it — the "before" half of the pair.
      return { needId: survey.needId, previousVersion: survey.methodologyVersion };
    });

    await this.audit.record({
      action: 'edit',
      entityType: 'survey',
      entityId: surveyId,
      entityLabel: `Methodology Version set to "${version}"`,
      metadata: this.actorRoleMetadata(),
      changes: [{ field: 'Methodology version', before: previousVersion, after: version }],
    });

    return this.getSurveyByNeedId(needId);
  }

  // Researcher: the Sample Description step (Target Group / Expected Sample
  // Size / Selection Approach / Geographic Coverage) — one Save action for
  // all four fields together, mandatory before submitForApproval will allow
  // SUBMITTED (see below). Shown read-only to the Approver during review
  // via toSurveyDetailDto; approveAndPublish/rejectSurvey never touch it.
  async setSampleDescription(
    surveyId: string,
    targetGroup: string,
    expectedSampleSize: number,
    selectionApproach: string,
    geographicCoverage: string,
  ) {
    // Only genuinely changed fields are recorded, so the audit entry shows
    // what the editor actually altered rather than restating all four.
    let sampleChanges: AuditChange[] = [];
    const needId = await this.tenant.runInOrgContext(async (tx) => {
      const survey = await tx.survey.findUnique({ where: { id: surveyId } });
      if (!survey) {
        throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
      }
      this.assertEditable(survey.status);
      sampleChanges = (
        [
          ['Target group', survey.targetGroup, targetGroup],
          ['Expected sample size', survey.expectedSampleSize, expectedSampleSize],
          ['Selection approach', survey.selectionApproach, selectionApproach],
          ['Geographic coverage', survey.geographicCoverage, geographicCoverage],
        ] as Array<[string, unknown, unknown]>
      )
        .filter(([, before, after]) => before !== after)
        .map(([field, before, after]) => ({ field, before, after }));
      await tx.survey.update({
        where: { id: surveyId },
        data: { targetGroup, expectedSampleSize, selectionApproach, geographicCoverage },
      });
      return survey.needId;
    });

    await this.audit.record({
      action: 'edit',
      entityType: 'survey',
      entityId: surveyId,
      entityLabel: 'Sample Description updated',
      metadata: this.actorRoleMetadata(),
      changes: sampleChanges,
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
          rejectionReasonCode: null,
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
      changes: [{ field: 'Status', before: 'DRAFT', after: 'SUBMITTED' }],
    });

    return updated;
  }

  // Approver: reviews and approves. Client-confirmed (Aug 13 call): approval
  // no longer publishes in the same step — it hands the survey back to the
  // Researcher, who does the actual publish (see publishSurvey below). No
  // editing window reopens in between (assertEditable blocks APPROVED).
  async approveSurvey(surveyId: string, comments: string) {
    requireNonBlank(comments, 'REVIEWER_NOTES_REQUIRED', 'Reviewer notes are required.');
    const survey = await this.tenant.runInOrgContext((tx) => tx.survey.findUnique({ where: { id: surveyId } }));
    if (!survey) {
      throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
    }
    // SUBMITTED is the legacy path (Researcher explicitly submitForApproval'd
    // first). DRAFT is the new AI Review flow's path — there is no separate
    // "submit for approval" step there; the Approver acts on the
    // auto-generated DRAFT survey directly (see AiDecisionsService.approveAiReview).
    if (survey.status !== 'SUBMITTED' && survey.status !== 'DRAFT') {
      throw new ConflictException({
        error: { code: 'SURVEY_NOT_PENDING_APPROVAL', message: 'This survey is not currently awaiting approval.' },
      });
    }

    const actorId = requireActor();
    const now = new Date();

    // methodologyVersion is deliberately NOT touched here — it's whatever
    // the Researcher already chose via setMethodologyVersion before
    // submitting (submitForApproval requires it to be set). The Approver
    // reviews exactly that choice; they never select or change it
    // themselves, and publishSurvey doesn't touch it either.
    const updated = await this.tenant.runInOrgContext((tx) =>
      tx.survey.update({
        where: { id: surveyId },
        data: {
          status: 'APPROVED',
          approvedAt: now,
          approvedBy: actorId,
          // Reused from the reject path — this column now holds the
          // reviewer's notes for whichever decision was made most recently,
          // approve or reject (see the field's own schema comment).
          approverComments: comments,
        },
      }),
    );

    await this.audit.record({
      action: 'approve',
      entityType: 'survey',
      entityId: surveyId,
      entityLabel: 'Survey approved — ready for the Researcher to publish',
      changes: [{ field: 'Approver Comments', before: null, after: comments }],
      metadata: this.actorRoleMetadata(),
    });

    return updated;
  }

  // Researcher (or anyone else holding surveyBuilder:write — NGO Admin,
  // System Admin, Field Researcher): the actual go-live step, once the
  // Approver has already approved. No reviewer notes here — that decision
  // was already recorded by approveSurvey; this is just "make it live."
  async publishSurvey(surveyId: string) {
    const survey = await this.tenant.runInOrgContext((tx) => tx.survey.findUnique({ where: { id: surveyId } }));
    if (!survey) {
      throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
    }
    if (survey.status !== 'APPROVED') {
      throw new ConflictException({
        error: { code: 'SURVEY_NOT_APPROVED', message: 'Only an approved survey can be published.' },
      });
    }

    const actorId = requireActor();
    const now = new Date();

    const updated = await this.tenant.runInOrgContext(async (tx) => {
      const row = await tx.survey.update({
        where: { id: surveyId },
        data: { status: 'PUBLISHED', publishedAt: now, publishedBy: actorId },
      });
      await tx.need.update({ where: { id: survey.needId }, data: { status: 'survey_published' } });

      // RIO-FR-011: publishing a new version supersedes the version it was
      // created from — without this, both rows would sit at PUBLISHED for
      // the same needId at once, and every "find the published survey for
      // this need" query elsewhere (scoring, priority calc, reports,
      // NCNP counts, citizen link resolution) would become non-deterministic
      // about which one it picks. Only `status` changes here — questions and
      // every response already attached to the old row are untouched, so
      // already-scored responses are never recalculated.
      if (survey.previousVersionId) {
        await tx.survey.update({
          where: { id: survey.previousVersionId },
          data: { status: 'SUPERSEDED' },
        });
      }
      return row;
    });

    await this.audit.record({
      action: 'edit',
      entityType: 'survey',
      entityId: surveyId,
      entityLabel: 'Survey published',
      changes: [{ field: 'Status', before: 'APPROVED', after: 'PUBLISHED' }],
      metadata: this.actorRoleMetadata(),
    });

    return updated;
  }

  // Approver: sends the survey back to the Researcher with required
  // comments. Never touches surveyQuestions — any content change has to
  // come from the Researcher through updateQuestions after this.
  async rejectSurvey(surveyId: string, reasonCode: RejectionReasonCode, comments: string) {
    requireNonBlank(comments, 'REVIEWER_NOTES_REQUIRED', 'Reviewer notes are required.');
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
          rejectionReasonCode: reasonCode,
          approverComments: comments,
        },
      }),
    );

    await this.audit.record({
      action: 'edit',
      entityType: 'survey',
      entityId: surveyId,
      entityLabel: 'Survey rejected',
      changes: [
        { field: 'Rejection Reason', before: null, after: reasonCode },
        { field: 'Approver Comments', before: null, after: comments },
      ],
      metadata: this.actorRoleMetadata(),
    });

    return updated;
  }

  async getPublicSurvey(id: string) {
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

  async submitSurvey(surveyId: string, answers: Record<string, string>) {
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
          answers: answers as Prisma.InputJsonValue
        }
      });
    });
  }

  async getSurveyResponses(surveyId: string) {
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
        const dto = this.toQuestionDto(sq, true);

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

  async listSurveys(opts: { organizationId?: string; studyId?: string; status?: string; search?: string; limit?: number; offset?: number }) {
    const store = getOrgStore();
    const isSysAdmin = store?.role === 'system_admin';

    const take = Math.min(Math.max(opts.limit ?? 100, 1), 200);
    const skip = Math.max(opts.offset ?? 0, 0);

    const needWhere: Prisma.NeedWhereInput = {
      ...(opts.organizationId ? { orgId: opts.organizationId } : {}),
      ...(opts.studyId ? { studyId: opts.studyId } : {}),
    };

    const where: Prisma.SurveyWhereInput = {
      ...(Object.keys(needWhere).length > 0 ? { need: needWhere } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.search ? { title: { contains: opts.search, mode: 'insensitive' } } : {}),
    };

    // `responses` is not a relation on Survey (response counts live on
    // Need.surveyResponses) — fetched here via the nested `need` include,
    // same as getSurveyDetailById below. A prior `include: { responses: ... }`
    // directly on Survey referenced a relation that doesn't exist and would
    // have thrown at query time the first time this endpoint was actually
    // called; caught here while removing `any` from this method's typing.
    const include = {
      need: { include: { study: true, org: true, surveyResponses: { select: { id: true } } } },
    };
    type SurveyListItem = Prisma.SurveyGetPayload<{ include: typeof include }>;
    let items: SurveyListItem[] = [];
    let total = 0;

    if (isSysAdmin) {
      const result = await this.tenant.runAsSupervisor((tx) =>
        Promise.all([
          tx.survey.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip, include }),
          tx.survey.count({ where }),
        ]),
      );
      items = result[0];
      total = result[1];

      await this.audit.record({
        action: 'SYSTEM_ADMIN_VIEWED_SURVEY',
        entityType: 'survey',
        entityId: opts.organizationId ?? null,
        entityLabel: opts.organizationId ? 'Organization Surveys' : 'All Platform Surveys',
        organizationId: opts.organizationId,
        metadata: { scope: opts.organizationId ? 'organization' : 'all' },
      });
    } else {
      const result = await this.tenant.runInOrgContext((tx) =>
        Promise.all([
          tx.survey.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip, include }),
          tx.survey.count({ where }),
        ]),
      );
      items = result[0];
      total = result[1];
    }

    return {
      items: items.map((s) => ({
        id: s.id,
        title: s.title ?? s.need?.title ?? 'Untitled Survey',
        needId: s.needId,
        studyId: s.need?.studyId ?? null,
        studyTitle: s.need?.study?.title ?? null,
        orgId: s.need?.orgId ?? null,
        orgName: s.need?.org?.name ?? null,
        status: s.status,
        version: s.version,
        // RIO-FR-011: this count is need-scoped, not survey-scoped (see the
        // schema note on SurveyResponse — it has no surveyId), so a DRAFT
        // version created via createNewVersion would otherwise show the
        // same non-zero count as the PUBLISHED version it was copied from,
        // even though a DRAFT has never gone live and could never actually
        // have collected any of them. Zero it out for anything that isn't
        // PUBLISHED/SUPERSEDED so the survey picker (this list) doesn't
        // point report generation at a version with no real data.
        responseCount:
          s.status === 'PUBLISHED' || s.status === 'SUPERSEDED' ? (s.need?.surveyResponses?.length ?? 0) : 0,
        publishedAt: s.publishedAt ? s.publishedAt.toISOString() : null,
        // Survey has no `closedAt` column (never did) — kept as a literal
        // null so the response shape is unchanged rather than dropping the
        // key; surfaced while removing `any` from this method's typing.
        closedAt: null,
        createdAt: s.createdAt ? s.createdAt.toISOString() : null,
      })),
      total,
      limit: take,
      offset: skip,
    };
  }

  async getSurveyDetailById(id: string) {
    const store = getOrgStore();
    const isSysAdmin = store?.role === 'system_admin';

    const include = {
      need: {
        include: {
          study: true,
          org: true,
          priorityScores: { take: 1, orderBy: { scoredAt: 'desc' as const } },
          _count: { select: { evidence: true } },
          surveyResponses: { select: { id: true, submittedAt: true } },
        },
      },
      surveyQuestions: { include: { question: true }, orderBy: { order: 'asc' as const } },
    };

    type SurveyDetailRow = Prisma.SurveyGetPayload<{ include: typeof include }>;
    let survey: SurveyDetailRow | null = null;
    if (isSysAdmin) {
      survey = await this.tenant.runAsSupervisor((tx) =>
        tx.survey.findUnique({ where: { id }, include }),
      );
      if (survey) {
        await this.audit.record({
          action: 'SYSTEM_ADMIN_VIEWED_SURVEY',
          entityType: 'survey',
          entityId: id,
          entityLabel: survey.title ?? survey.need?.title ?? 'Untitled Survey',
          organizationId: survey.need?.orgId,
        });
      }
    } else {
      survey = await this.tenant.runInOrgContext((tx) =>
        tx.survey.findUnique({ where: { id }, include }),
      );
    }

    if (!survey) {
      throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'Survey not found' } });
    }

    const questions = (survey.surveyQuestions ?? []).map((sq) => this.toQuestionDto(sq, true));
    // RIO-FR-011: need-scoped, not survey-scoped (see listSurveys' matching
    // note) — a DRAFT version has never gone live, so it structurally can't
    // own any of the Need's responses even though the count itself is
    // shared across every version.
    const responses =
      survey.status === 'PUBLISHED' || survey.status === 'SUPERSEDED' ? (survey.need?.surveyResponses ?? []) : [];

    return {
      id: survey.id,
      title: survey.title ?? survey.need?.title ?? 'Untitled Survey',
      needId: survey.needId,
      studyId: survey.need?.studyId ?? null,
      studyTitle: survey.need?.study?.title ?? null,
      orgId: survey.need?.orgId ?? null,
      orgName: survey.need?.org?.name ?? null,
      village: Array.isArray(survey.need?.village) ? survey.need.village.join(', ') : (survey.need?.village ?? '—'),
      domainCategory: survey.need?.domain ?? survey.need?.aiSuggestedDomain ?? '—',
      status: survey.status,
      version: survey.version,
      previousVersionId: survey.previousVersionId,
      // Survey has no `publicToken` field — the citizen-facing public link
      // token lives on PublicSurveyLink (a separate model, see
      // public-surveys.service.ts), which this query doesn't join. Kept as a
      // literal null so the response shape is unchanged; surfaced while
      // removing `any` from this method's typing.
      publicToken: null,
      methodologyVersionId: survey.methodologyVersion,
      questionsCount: questions.length,
      responseCount: responses.length,
      evidenceCount: survey.need?._count?.evidence ?? 0,
      score: survey.need?.priorityScores?.[0]?.overallScore ?? null,
      questions,
      // Pre-existing bug (unrelated to survey versioning, found while adding
      // the FR-011 e2e test): this was selecting a `channel` field that has
      // never existed on SurveyResponse, 500ing this endpoint for any survey
      // with responses. There is currently no field anywhere that
      // distinguishes a citizen self-submission from a field-collector one —
      // reporting that split accurately needs a real schema addition, out of
      // scope here. Reporting everything as field-collector is the closest
      // safe placeholder given today's live traffic (the citizen OTP channel
      // is soft-disabled) rather than a fabricated split.
      responsesSummary: {
        total: responses.length,
        citizenChannelCount: 0,
        fieldCollectorCount: responses.length,
      },
      publishedAt: survey.publishedAt ? survey.publishedAt.toISOString() : null,
      // Survey has no `closedAt` column (never did) — see the matching note
      // in listSurveys above.
      closedAt: null,
      createdAt: survey.createdAt ? survey.createdAt.toISOString() : null,
    };
  }
}
