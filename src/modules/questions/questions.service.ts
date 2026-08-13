import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { Prisma } from '../../generated/prisma';

@Injectable()
export class QuestionsService {
  constructor(private readonly tenant: TenantPrismaService) {}

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
   * hold under the sensitivity protocol).
   */
  private selectableWhere(methodologyVersionId: string): Prisma.QuestionWhereInput {
    return { methodologyVersionId, usedInMvp: true, isFielded: true };
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
    return rows.map((r) => ({
      id: r.id,
      questionId: r.questionId,
      domain: r.domain,
      subDomain: r.subDomain,
      indicator: r.indicator,
      kpi: r.kpi,
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
    }));
  }
}
