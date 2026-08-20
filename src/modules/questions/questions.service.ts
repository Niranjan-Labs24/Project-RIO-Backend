import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { AuditService } from '../audit/audit.service';
import { requireActor } from '../../tenancy/org-context';
import { Prisma } from '../../generated/prisma';

export interface UpdateQuestionInput {
  questionText?: string;
  domain?: string;
  subDomain?: string;
  indicator?: string | null;
  kpi?: string | null;
}

@Injectable()
export class QuestionsService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * RIO-AI-005: a question's identity is (methodologyVersionId, questionId), so
   * every Question Bank read has to name a version. An explicit `label` is the
   * caller's own snapshot (Survey.methodologyVersion); with none, the latest
   * PUBLISHED version wins — the same fallback DeterministicScoringService and
   * ScoreRollupService already use, so the picker can never offer questions from
   * a version the scoring engine would not resolve.
   *
   * Deliberately NOT "any version": before version scoping existed, these reads
   * spanned every bank at once, which is what let a second import surface ~297
   * near-identical questions and made surveys pick the unscoreable legacy twin
   * of a real question.
   */
  private async resolveVersionId(label?: string): Promise<string> {
    const mv = await this.tenant.runAsSupervisor((tx) =>
      tx.methodologyVersion.findFirst({
        where: label ? { version: label } : { status: 'PUBLISHED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      }),
    );
    if (!mv) {
      throw new NotFoundException({
        error: {
          code: 'METHODOLOGY_VERSION_NOT_FOUND',
          message: label
            ? `Methodology version "${label}" is not configured on this platform.`
            : 'No published methodology version is configured yet. Import and publish the approved methodology baseline first.',
        },
      });
    }
    return mv.id;
  }

  /**
   * Only fielded questions are selectable: the 7 questionnaire-structure, roster
   * and template-pattern modules (XDM-01..07) are instrument scaffolding, not
   * questions a Researcher can add to a survey. `usedInMvp` additionally hides
   * anything the methodology marks as out of MVP scope (and SOC-08, which is on
   * hold under the sensitivity protocol). `isActive` excludes a deactivated
   * question (RIO-FR-012) from new-survey browsing and AI recommendations —
   * deliberately NOT filtered on already-published SurveyQuestion rows
   * elsewhere, so a survey that already included it is untouched.
   */
  private selectableWhere(methodologyVersionId: string): Prisma.QuestionWhereInput {
    return {
      methodologyVersionId,
      usedInMvp: true,
      isFielded: true,
      isActive: true,
      // RIO-FR-012 (Q30/Q31, client-confirmed 2026-08-20) — a pending or
      // historical version must never surface here: new surveys are always
      // built from whichever row is both current AND already approved.
      isCurrentVersion: true,
      approvalStatus: 'approved',
    };
  }

  async getDomainOptions(methodologyVersion?: string): Promise<Array<{ domain: string; subDomain: string }>> {
    const methodologyVersionId = await this.resolveVersionId(methodologyVersion);
    return this.tenant.runAsSupervisor((tx) =>
      tx.question.findMany({
        where: this.selectableWhere(methodologyVersionId),
        select: { domain: true, subDomain: true },
        distinct: ['domain', 'subDomain'],
        orderBy: [{ domain: 'asc' }, { subDomain: 'asc' }],
      }),
    );
  }

  // Suggestions for the Custom Question Editor's KPI field — free text
  // remains the final value either way (KPI has no fixed vocabulary the way
  // Domain/Sub-domain do, since it's nearly 1:1 with individual questions),
  // this just surfaces what's already in use so a Researcher naming a new
  // custom question's KPI can reuse existing wording instead of guessing.
  async getKpiOptions(methodologyVersion?: string): Promise<string[]> {
    const methodologyVersionId = await this.resolveVersionId(methodologyVersion);
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.question.findMany({
        where: { ...this.selectableWhere(methodologyVersionId), kpi: { not: null } },
        select: { kpi: true },
        distinct: ['kpi'],
        orderBy: { kpi: 'asc' },
      }),
    );
    return rows.map((r) => r.kpi).filter((kpi): kpi is string => Boolean(kpi));
  }

  // Empty `pairs` means "every selectable Question Bank entry in this version" —
  // used for a Need that's allDomainsSelected (AI couldn't classify it into
  // anything specific), same convention as
  // SurveysService.generateSuggestedQuestions on the multi-domain path.
  // Non-empty `pairs` matches any of them (OR), covering both a single
  // classified pair and an already-approved multi-domain Need's several pairs.
  async getQuestions(
    pairs: Array<{ domain: string; subDomain: string }>,
    methodologyVersion?: string,
  ) {
    const methodologyVersionId = await this.resolveVersionId(methodologyVersion);
    const base = this.selectableWhere(methodologyVersionId);
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.question.findMany({
        where:
          pairs.length > 0
            ? { ...base, OR: pairs.map((p) => ({ domain: p.domain, subDomain: p.subDomain })) }
            : base,
        orderBy: { questionId: 'asc' },
      }),
    );
    return rows.map((r) => this.toQuestionRow(r));
  }

  // RIO-FR-012 — admin management listing. Same structural filters as
  // getQuestions (usedInMvp/isFielded still exclude instrument scaffolding
  // like XDM-01..07) but deliberately WITHOUT the isActive filter
  // selectableWhere applies — an admin curating the bank needs to see
  // deactivated questions too, in order to reactivate them. Gated at the
  // controller on methodologyQuestionBank:write (NCNP Admin only, per
  // Q31), unlike getQuestions (read-only, used by the Survey Builder's own
  // question-bank browsing). Always isCurrentVersion:true — a row with a
  // pending edit still shows its live (pre-edit) content here until that
  // edit is approved; the pending edit itself is visible via
  // listPendingApprovals.
  async getQuestionsForManagement(
    pairs: Array<{ domain: string; subDomain: string }>,
    methodologyVersion?: string,
  ) {
    const methodologyVersionId = await this.resolveVersionId(methodologyVersion);
    const base: Prisma.QuestionWhereInput = {
      methodologyVersionId,
      usedInMvp: true,
      isFielded: true,
      isCurrentVersion: true,
    };
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.question.findMany({
        where:
          pairs.length > 0
            ? { ...base, OR: pairs.map((p) => ({ domain: p.domain, subDomain: p.subDomain })) }
            : base,
        orderBy: { questionId: 'asc' },
      }),
    );
    return rows.map((r) => this.toQuestionRow(r));
  }

  // RIO-FR-012 (Q31) — Human Reviewer's approval queue: every question-bank
  // change (edit/deactivate/reactivate) submitted by NCNP Admin sits here as
  // a non-current, pending row until approved or rejected. Cross-version
  // scoped (not filtered by methodologyVersionId) since a Reviewer's queue
  // is a single worklist, not a per-version browse.
  async listPendingApprovals() {
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.question.findMany({
        where: { approvalStatus: 'pending_approval' },
        orderBy: { submittedAt: 'asc' },
      }),
    );
    return rows.map((r) => this.toQuestionRow(r));
  }

  private toQuestionRow(r: {
    id: string;
    questionId: string;
    domain: string;
    subDomain: string;
    indicator: string | null;
    kpi: string | null;
    priorityWeight: Prisma.Decimal | null;
    questionText: string;
    answerType: string;
    answerOptions: unknown;
    requiredOptional: string;
    usedInMvp: boolean;
    reportMapping: string | null;
    answerTypeRaw: string | null;
    measurementMode: string;
    rosterScope: string | null;
    rosterLoop: string | null;
    isCompound: boolean;
    isScoreable: boolean;
    analyticalCategory: string | null;
    targetRespondent: string | null;
    feedsKpiAnchor: string | null;
    isActive: boolean;
    deactivatedAt: Date | null;
    version: number;
    isCurrentVersion: boolean;
    approvalStatus: string;
    submittedAt: Date | null;
    reviewedAt: Date | null;
    rejectionReason: string | null;
  }) {
    return {
      id: r.id,
      questionId: r.questionId,
      domain: r.domain,
      subDomain: r.subDomain,
      indicator: r.indicator,
      kpi: r.kpi,
      // RIO-AI-002: the Domain → Indicator → KPI → Weight linkage needs to
      // be visible wherever a Researcher browses/picks Question Bank
      // entries, not just after they've been added to a survey (see
      // SurveysService.toQuestionDto's includeWeight for that side).
      priorityWeight: r.priorityWeight?.toNumber() ?? null,
      questionText: r.questionText,
      answerType: r.answerType,
      answerOptions: typeof r.answerOptions === 'string' ? JSON.parse(r.answerOptions) : r.answerOptions,
      requiredOptional: r.requiredOptional,
      usedInMvp: r.usedInMvp,
      reportMapping: r.reportMapping,
      // v5.0 methodology attributes the Survey Builder needs to render and
      // explain a question correctly — the raw answer-type label, whether it is
      // administered per eligible person, its analytical category (which governs
      // what a poor score implies), and whether it is a diagnostic item that
      // deliberately does not enter the scores.
      answerTypeRaw: r.answerTypeRaw,
      measurementMode: r.measurementMode,
      rosterScope: r.rosterScope,
      rosterLoop: r.rosterLoop,
      isCompound: r.isCompound,
      isScoreable: r.isScoreable,
      analyticalCategory: r.analyticalCategory,
      targetRespondent: r.targetRespondent,
      feedsKpiAnchor: r.feedsKpiAnchor,
      // RIO-FR-012 — admin management state. Always PUBLISHED true on the
      // read-only getQuestions() path (selectableWhere filters isActive:true),
      // but meaningful on getQuestionsForManagement, which shows both.
      isActive: r.isActive,
      deactivatedAt: r.deactivatedAt ? r.deactivatedAt.toISOString() : null,
      // RIO-FR-012 (Q30/Q31) — version/approval state, so the admin UI can
      // show "pending approval" and the Reviewer's queue can show what
      // changed and when it was submitted.
      version: r.version,
      isCurrentVersion: r.isCurrentVersion,
      approvalStatus: r.approvalStatus,
      submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
      reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
      rejectionReason: r.rejectionReason,
    };
  }

  private async findOrThrow(id: string) {
    const row = await this.tenant.runAsSupervisor((tx) => tx.question.findUnique({ where: { id } }));
    if (!row) {
      throw new NotFoundException({ error: { code: 'QUESTION_NOT_FOUND', message: 'Question not found' } });
    }
    return row;
  }

  // RIO-FR-012 (Q30/Q31, client-confirmed 2026-08-20) — every submitted
  // change creates a NEW row rather than mutating the current one in place,
  // pinned to isCurrentVersion:false + approvalStatus:'pending_approval'
  // until a Human Reviewer approves it. The row this creates from is left
  // completely untouched (still isCurrentVersion:true, still governing new
  // surveys and Question Bank browsing) — this is also what keeps an
  // already-published SurveyQuestion pinned to its exact original config:
  // its FK points at that untouched row's id, which this method never
  // updates or deletes.
  private async createPendingVersion(
    currentId: string,
    overrides: Partial<
      Pick<
        Prisma.QuestionUncheckedCreateInput,
        'questionText' | 'domain' | 'subDomain' | 'indicator' | 'kpi' | 'isActive' | 'deactivatedAt' | 'deactivatedBy'
      >
    >,
  ) {
    const actorId = requireActor();
    const current = await this.findOrThrow(currentId);
    if (!current.isCurrentVersion) {
      throw new ConflictException({
        error: {
          code: 'QUESTION_NOT_CURRENT_VERSION',
          message: 'This question row is not the current version — refresh and try again.',
        },
      });
    }
    if (current.approvalStatus === 'pending_approval') {
      throw new ConflictException({
        error: {
          code: 'QUESTION_HAS_PENDING_CHANGE',
          message: 'This question already has a change awaiting Human Reviewer approval.',
        },
      });
    }

    // Destructure out the identity/version-bookkeeping fields that must
    // never be copied verbatim into the new row.
    const {
      id: _id,
      version,
      isCurrentVersion: _isCurrentVersion,
      approvalStatus: _approvalStatus,
      previousVersionId: _previousVersionId,
      submittedBy: _submittedBy,
      submittedAt: _submittedAt,
      reviewedBy: _reviewedBy,
      reviewedAt: _reviewedAt,
      rejectionReason: _rejectionReason,
      answerOptions,
      conditionalRule,
      ...rest
    } = current;

    const pending = await this.tenant.runAsSupervisorWrite((tx) =>
      tx.question.create({
        data: {
          ...rest,
          answerOptions: answerOptions === null ? Prisma.JsonNull : answerOptions,
          conditionalRule: conditionalRule === null ? Prisma.JsonNull : conditionalRule,
          ...overrides,
          version: version + 1,
          isCurrentVersion: false,
          approvalStatus: 'pending_approval',
          previousVersionId: current.id,
          submittedBy: actorId,
          submittedAt: new Date(),
        },
      }),
    );

    await this.audit.record({
      action: 'edit',
      entityType: 'question',
      entityId: pending.id,
      entityLabel: current.questionText,
      changes: (Object.keys(overrides) as Array<keyof typeof overrides>).map((k) => ({
        field: k,
        before: current[k as keyof typeof current],
        after: overrides[k],
      })),
      metadata: { supersedes: current.id, awaitingApproval: true },
    });

    return pending;
  }

  // RIO-FR-012 — admin edit. See createPendingVersion: the edit does not
  // take effect for new surveys until a Human Reviewer approves it, and an
  // already-published survey is unaffected either way (its SurveyQuestion
  // row is pinned to the pre-edit row's id, which is never touched).
  async update(id: string, input: UpdateQuestionInput) {
    return this.createPendingVersion(id, input);
  }

  async deactivate(id: string) {
    const actorId = requireActor();
    return this.createPendingVersion(id, {
      isActive: false,
      deactivatedAt: new Date(),
      deactivatedBy: actorId,
    });
  }

  async reactivate(id: string) {
    return this.createPendingVersion(id, {
      isActive: true,
      deactivatedAt: null,
      deactivatedBy: null,
    });
  }

  // RIO-FR-012 (Q31) — Human Reviewer approves a pending change: the pending
  // row becomes the current version, and the row it supersedes is flipped
  // off isCurrentVersion (its own approvalStatus stays 'approved' — it WAS
  // a real approved version, just no longer the live one; already-published
  // surveys keep resolving to it by id regardless).
  async approve(id: string) {
    const actorId = requireActor();
    const pending = await this.findOrThrow(id);
    if (pending.approvalStatus !== 'pending_approval') {
      throw new ConflictException({
        error: { code: 'QUESTION_NOT_PENDING', message: 'This question change is not awaiting approval.' },
      });
    }
    const previous = pending.previousVersionId
      ? await this.tenant.runAsSupervisor((tx) =>
          tx.question.findUnique({ where: { id: pending.previousVersionId! } }),
        )
      : null;

    const updated = await this.tenant.runAsSupervisorWrite(async (tx) => {
      if (pending.previousVersionId) {
        await tx.question.update({
          where: { id: pending.previousVersionId },
          data: { isCurrentVersion: false },
        });
      }
      return tx.question.update({
        where: { id },
        data: { approvalStatus: 'approved', isCurrentVersion: true, reviewedBy: actorId, reviewedAt: new Date() },
      });
    });

    // RIO-FR-007 — before/after pair required for every 'approve' event.
    // Diffs the fields a Question Bank edit can actually touch (see
    // UpdateQuestionInput / createPendingVersion's overrides) against the
    // version this approval supersedes.
    const diffFields: Array<keyof typeof updated> = [
      'questionText',
      'domain',
      'subDomain',
      'indicator',
      'kpi',
      'isActive',
    ];
    const changes = previous
      ? diffFields
          .filter((f) => previous[f] !== updated[f])
          .map((f) => ({ field: String(f), before: previous[f], after: updated[f] }))
      : [{ field: 'approvalStatus', before: 'pending_approval', after: 'approved' }];

    await this.audit.record({
      action: 'approve',
      entityType: 'question',
      entityId: id,
      entityLabel: pending.questionText,
      changes,
      metadata: { supersedes: pending.previousVersionId },
    });
    return updated;
  }

  async reject(id: string, reason: string) {
    const actorId = requireActor();
    const pending = await this.findOrThrow(id);
    if (pending.approvalStatus !== 'pending_approval') {
      throw new ConflictException({
        error: { code: 'QUESTION_NOT_PENDING', message: 'This question change is not awaiting approval.' },
      });
    }
    const updated = await this.tenant.runAsSupervisorWrite((tx) =>
      tx.question.update({
        where: { id },
        data: {
          approvalStatus: 'rejected',
          reviewedBy: actorId,
          reviewedAt: new Date(),
          rejectionReason: reason,
        },
      }),
    );
    await this.audit.record({
      action: 'reject',
      entityType: 'question',
      entityId: id,
      entityLabel: pending.questionText,
      changes: [{ field: 'Rejection reason', before: null, after: reason }],
    });
    return updated;
  }
}
