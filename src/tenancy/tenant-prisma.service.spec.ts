import { MissingOrgContextError, orgContext } from './org-context';
import { TenantPrismaService } from './tenant-prisma.service';

function makeFakePrisma() {
  const calls: string[] = [];
  const tx = {
    $executeRaw: (_s: TemplateStringsArray, ..._v: unknown[]) => {
      calls.push('set_config');
      return Promise.resolve(1);
    },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { prisma, calls, tx };
}

describe('TenantPrismaService.runInOrgContext', () => {
  it('throws MissingOrgContextError when there is no org context', async () => {
    const { prisma } = makeFakePrisma();
    const svc = new TenantPrismaService(prisma as never, prisma as never);
    await expect(svc.runInOrgContext(async () => 'x')).rejects.toBeInstanceOf(
      MissingOrgContextError,
    );
  });

  it('sets org context and runs the callback inside a transaction', async () => {
    const { prisma, calls } = makeFakePrisma();
    const svc = new TenantPrismaService(prisma as never, prisma as never);
    const result = await orgContext.run({ requestId: 'r1', orgId: 'org-123' }, () =>
      svc.runInOrgContext(async (tx) => {
        expect(tx).toBeDefined();
        return 'ok';
      }),
    );
    expect(result).toBe('ok');
    expect(calls).toContain('set_config');
  });
});

describe('TenantPrismaService.runAsOrg / runAsSupervisor', () => {
  it('runAsOrg sets an explicit org and runs the callback in a transaction', async () => {
    const { prisma, calls } = makeFakePrisma();
    const svc = new TenantPrismaService(prisma as never, prisma as never);
    const result = await svc.runAsOrg('org-999', async () => 'bootstrapped');
    expect(result).toBe('bootstrapped');
    expect(calls).toContain('set_config');
  });

  it('runAsSupervisor runs the callback against the supervisor client (no org GUC)', async () => {
    const { prisma } = makeFakePrisma();
    const sup = makeFakePrisma();
    const svc = new TenantPrismaService(prisma as never, sup.prisma as never);
    const result = await svc.runAsSupervisor(async () => 'cross-org');
    expect(result).toBe('cross-org');
    // supervisor path does not set an org GUC
    expect(sup.calls).not.toContain('set_config');
  });
});
