import { ROLE_KEYS } from '../rbac/role-keys';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { SupervisorPrismaService } from '../prisma/supervisor-prisma.service';
import { getOrgStore, requireOrgId } from './org-context';

@Injectable()
export class TenantPrismaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supervisor: SupervisorPrismaService,
  ) {}

  /**
   * Ambient-org transaction, fail-closed. Runs `fn` inside one pinned
   * interactive transaction with app.current_org_id set (transaction-local).
   * Throws MissingOrgContextError if no org context is in scope.
   */
  async runInOrgContext<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.runAsOrg(requireOrgId(), fn);
  }

  /**
   * READ helper: platform-wide roles (system_admin, system_reviewer) and the
   * cross-entity center_supervisor have no tenant org of their own, so a plain
   * runInOrgContext read 404s/returns empty for records in any other org.
   * Use only for read-only callbacks (the supervisor client is SELECT-only).
   */
  async runRead<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const role = getOrgStore()?.role;
    const crossOrg = role === ROLE_KEYS.systemAdmin || role === ROLE_KEYS.systemReviewer || role === ROLE_KEYS.centerSupervisor;
    return crossOrg ? this.runAsSupervisor(fn) : this.runInOrgContext(fn);
  }

  /** Explicit-org transaction (org-creation bootstrap). */
  async runAsOrg<T>(orgId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      return fn(tx);
    });
  }

  /**
   * Cross-org READ path for crossEntity roles (system_admin, center_supervisor).
   * Uses the SELECT-only cnap_supervisor client; no org GUC is set.
   */
  async runAsSupervisor<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.supervisor.$transaction(async (tx) => fn(tx));
  }

  /**
   * Cross-org WRITE path for crossEntity roles, for tables with no orgId/RLS
   * (global reference data, e.g. NcnpReportReview). Uses the read-write
   * cnap_app client with no org GUC set — safe only because the target
   * table has no row-level security policy to bypass.
   */
  async runAsSupervisorWrite<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => fn(tx));
  }
}
