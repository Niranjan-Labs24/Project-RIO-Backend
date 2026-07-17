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

  async getQuestions(domain: string, subDomain: string) {
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.question.findMany({
        where: { domain, subDomain, usedInMvp: true },
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
