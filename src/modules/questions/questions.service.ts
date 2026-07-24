import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';

@Injectable()
export class QuestionsService {
  constructor(private readonly tenant: TenantPrismaService) {}

  async getDomainOptions(): Promise<Array<{ domain: string; subDomain: string }>> {
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.question.findMany({
        where: { usedInMvp: true },
        select: { domain: true, subDomain: true },
        distinct: ['domain', 'subDomain'],
        orderBy: [{ domain: 'asc' }, { subDomain: 'asc' }],
      }),
    );
    return rows;
  }

  // Suggestions for the Custom Question Editor's KPI field — free text
  // remains the final value either way (KPI has no fixed vocabulary the way
  // Domain/Sub-domain do, since it's nearly 1:1 with individual questions),
  // this just surfaces what's already in use so a Researcher naming a new
  // custom question's KPI can reuse existing wording instead of guessing.
  async getKpiOptions(): Promise<string[]> {
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.question.findMany({
        where: { usedInMvp: true, kpi: { not: null } },
        select: { kpi: true },
        distinct: ['kpi'],
        orderBy: { kpi: 'asc' },
      }),
    );
    return rows.map((r) => r.kpi).filter((kpi): kpi is string => Boolean(kpi));
  }

  // Empty `pairs` means "every active Question Bank entry" — used for a
  // Need that's allDomainsSelected (AI couldn't classify it into anything
  // specific), same convention as SurveysService.generateSuggestedQuestions
  // on the multi-domain path. Non-empty `pairs` matches any of them (OR),
  // covering both a single classified pair and an already-approved
  // multi-domain Need's several pairs.
  async getQuestions(pairs: Array<{ domain: string; subDomain: string }>) {
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.question.findMany({
        where:
          pairs.length > 0
            ? { usedInMvp: true, OR: pairs.map((p) => ({ domain: p.domain, subDomain: p.subDomain })) }
            : { usedInMvp: true },
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
    }));
  }
}
