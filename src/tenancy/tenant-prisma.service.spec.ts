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

describe('TenantPrismaService.runRead', () => {
  function twoClients() {
    const used: string[] = [];
    const client = (name: string) => ({
      $transaction: (fn: (t: unknown) => Promise<unknown>) => {
        used.push(name);
        const tx = { $executeRaw: () => Promise.resolve(1) };
        return fn(tx);
      },
    });
    return { used, svc: new TenantPrismaService(client('app') as never, client('supervisor') as never) };
  }

  it.each(['system_admin', 'system_reviewer', 'center_supervisor'])(
    'reads across organizations through the supervisor client for %s',
    async (role) => {
      const { svc, used } = twoClients();
      await orgContext.run({ requestId: 'r', orgId: 'own-org', role }, () => svc.runRead(async () => 'ok'));
      expect(used).toEqual(['supervisor']);
    },
  );

  it.each(['ngo_admin', 'research_officer', 'data_analyst', undefined])(
    'stays scoped to the caller org for %s',
    async (role) => {
      const { svc, used } = twoClients();
      await orgContext.run({ requestId: 'r', orgId: 'own-org', role }, () => svc.runRead(async () => 'ok'));
      expect(used).toEqual(['app']);
    },
  );

  it('still requires an org context for a tenant-scoped role', async () => {
    const { svc } = twoClients();
    await expect(
      orgContext.run({ requestId: 'r', role: 'ngo_admin' }, () => svc.runRead(async () => 'x')),
    ).rejects.toBeInstanceOf(MissingOrgContextError);
  });
});
