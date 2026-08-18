import { Injectable, NotFoundException } from '@nestjs/common';
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
    return { methodologyVersionId, usedInMvp: true, isFielded: true, isActive: true };
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
  // controller on surveyBuilder:write, unlike getQuestions (read-only,
  // used by the Survey Builder's own question-bank browsing).
  async getQuestionsForManagement(
    pairs: Array<{ domain: string; subDomain: string }>,
    methodologyVersion?: string,
  ) {
    const methodologyVersionId = await this.resolveVersionId(methodologyVersion);
    const base: Prisma.QuestionWhereInput = {
      methodologyVersionId,
      usedInMvp: true,
      isFielded: true,
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
    };
  }

  private async findOrThrow(id: string) {
    const row = await this.tenant.runAsSupervisor((tx) => tx.question.findUnique({ where: { id } }));
    if (!row) {
      throw new NotFoundException({ error: { code: 'QUESTION_NOT_FOUND', message: 'Question not found' } });
    }
    return row;
  }

  // RIO-FR-012 — admin edit. Editing a question's text/domain/indicator does
  // NOT touch already-published surveys: SurveyQuestion snapshots its own
  // questionText at the point a survey was built (see SurveysService), so an
  // edit here only ever affects future surveys built from the bank after
  // this point — matching the story's "does not retroactively alter
  // already-published survey results" requirement without any extra work.
  async update(id: string, input: UpdateQuestionInput) {
    const existing = await this.findOrThrow(id);
    const updated = await this.tenant.runAsSupervisor((tx) =>
      tx.question.update({ where: { id }, data: input }),
    );
    await this.audit.record({
      action: 'edit',
      entityType: 'question',
      entityId: id,
      entityLabel: existing.questionText,
      changes: (Object.keys(input) as Array<keyof UpdateQuestionInput>)
        .filter((k) => input[k] !== undefined)
        .map((k) => ({ field: k, before: existing[k], after: input[k] })),
    });
    return updated;
  }

  // ⚠️ Default behaviour, not yet client-confirmed (Sprint 2 clarification
  // Q3) — see the schema comment on Question.isActive for what's still open.
  async deactivate(id: string) {
    const actorId = requireActor();
    const existing = await this.findOrThrow(id);
    if (!existing.isActive) {
      return existing;
    }
    const updated = await this.tenant.runAsSupervisor((tx) =>
      tx.question.update({
        where: { id },
        data: { isActive: false, deactivatedAt: new Date(), deactivatedBy: actorId },
      }),
    );
    await this.audit.record({
      action: 'edit',
      entityType: 'question',
      entityId: id,
      entityLabel: existing.questionText,
      changes: [{ field: 'Status', before: 'Active', after: 'Deactivated' }],
    });
    return updated;
  }

  async reactivate(id: string) {
    const existing = await this.findOrThrow(id);
    if (existing.isActive) {
      return existing;
    }
    const updated = await this.tenant.runAsSupervisor((tx) =>
      tx.question.update({
        where: { id },
        data: { isActive: true, deactivatedAt: null, deactivatedBy: null },
      }),
    );
    await this.audit.record({
      action: 'edit',
      entityType: 'question',
      entityId: id,
      entityLabel: existing.questionText,
      changes: [{ field: 'Status', before: 'Deactivated', after: 'Active' }],
    });
    return updated;
  }
}
