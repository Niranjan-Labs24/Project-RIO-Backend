import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { requireOrgId } from './org-context';

@Injectable()
export class TenantPrismaService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `fn` inside one pinned interactive transaction with
   * app.current_org_id set (transaction-local). Fails closed: throws if no org context.
   */
  async runInOrgContext<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const orgId = requireOrgId();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      return fn(tx);
    });
  }
}
