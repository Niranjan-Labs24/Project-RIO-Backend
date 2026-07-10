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
    const svc = new TenantPrismaService(prisma as never);
    await expect(svc.runInOrgContext(async () => 'x')).rejects.toBeInstanceOf(
      MissingOrgContextError,
    );
  });

  it('sets org context and runs the callback inside a transaction', async () => {
    const { prisma, calls } = makeFakePrisma();
    const svc = new TenantPrismaService(prisma as never);
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
