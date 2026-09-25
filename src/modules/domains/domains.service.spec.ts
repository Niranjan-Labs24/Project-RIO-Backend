import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma';
import { makeFakeTx } from '../../../test/support/fake-tx';
import { DomainsService } from './domains.service';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  code: 'W',
  name: 'Water',
  nameAr: 'ماء',
  displayOrder: 1,
  isActive: true,
  ...over,
});
const sub = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  domainId: 'd1',
  code: 'WS',
  name: 'Supply',
  nameAr: 'x',
  displayOrder: 1,
  isActive: true,
  ...over,
});

function setup() {
  const extras: Record<string, unknown> = {};
  const prisma = makeFakeTx(extras);
  extras.$transaction = vi.fn(async (fn: (t: unknown) => unknown) => fn(prisma));
  return { prisma, svc: new DomainsService(prisma as never) };
}
const dup = () =>
  new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
const code = (c: string) =>
  expect.objectContaining({ response: { error: expect.objectContaining({ code: c }) } });

describe('DomainsService reads', () => {
  it('lists domains, active names and the active tree', async () => {
    const { prisma, svc } = setup();
    prisma.domain.findMany.mockResolvedValue([row()]);
    expect(await svc.listDomains()).toEqual([row()]);
    expect(await svc.listActiveNames()).toHaveLength(1);
    expect(await svc.listActiveTree()).toHaveLength(1);
  });

  it('lists domains with their sub-domains in one query', async () => {
    const { prisma, svc } = setup();
    prisma.domain.findMany.mockResolvedValue([{ ...row(), subDomains: [sub()] }]);
    const out = await svc.listDomainsWithSubDomains();
    expect(out[0]!.subDomains[0]).toMatchObject({ code: 'WS', domainId: 'd1' });
    expect(prisma.domain.findMany).toHaveBeenCalledTimes(1);
  });

  it('lists the sub-domains of an existing domain and refuses an unknown one', async () => {
    const { prisma, svc } = setup();
    prisma.domain.findUnique.mockResolvedValueOnce(row());
    prisma.subDomain.findMany.mockResolvedValue([sub()]);
    expect(await svc.listSubDomains('d1')).toHaveLength(1);
    prisma.domain.findUnique.mockResolvedValueOnce(null);
    await expect(svc.listSubDomains('x')).rejects.toThrow(code('DOMAIN_NOT_FOUND'));
  });
});

describe('DomainsService domain writes', () => {
  it('creates a domain with a default order, and maps a duplicate code to a conflict', async () => {
    const { prisma, svc } = setup();
    prisma.domain.create.mockResolvedValueOnce(row());
    await svc.createDomain({ code: 'W', name: 'Water', nameAr: 'ماء' } as never);
    expect(prisma.domain.create.mock.calls[0]![0].data.displayOrder).toBe(0);
    prisma.domain.create.mockRejectedValueOnce(dup());
    await expect(
      svc.createDomain({ code: 'W', name: 'n', nameAr: 'a', displayOrder: 2 } as never),
    ).rejects.toThrow(code('DOMAIN_CODE_ALREADY_EXISTS'));
    const other = new Error('boom');
    prisma.domain.create.mockRejectedValueOnce(other);
    await expect(svc.createDomain({ code: 'W', name: 'n', nameAr: 'a' } as never)).rejects.toBe(
      other,
    );
  });

  it('updates a domain, refusing an unknown id or a duplicate code', async () => {
    const { prisma, svc } = setup();
    prisma.domain.findUnique.mockResolvedValue(row());
    prisma.domain.update.mockResolvedValueOnce(row({ name: 'New' }));
    expect((await svc.updateDomain('d1', { name: 'New' } as never)).name).toBe('New');
    prisma.domain.update.mockRejectedValueOnce(dup());
    await expect(svc.updateDomain('d1', {} as never)).rejects.toThrow(
      code('DOMAIN_CODE_ALREADY_EXISTS'),
    );
    prisma.domain.findUnique.mockResolvedValueOnce(null);
    await expect(svc.updateDomain('x', {} as never)).rejects.toThrow(code('DOMAIN_NOT_FOUND'));
  });

  it('deactivating a domain also deactivates its sub-domains, but reactivating does not bring them back', async () => {
    const { prisma, svc } = setup();
    prisma.domain.findUnique.mockResolvedValue(row());
    prisma.domain.update.mockResolvedValue(row({ isActive: false }));
    await svc.setDomainActive('d1', false);
    expect(prisma.subDomain.updateMany).toHaveBeenCalledWith({
      where: { domainId: 'd1', isActive: true },
      data: { isActive: false },
    });
    prisma.subDomain.updateMany.mockClear();
    await svc.setDomainActive('d1', true);
    expect(prisma.subDomain.updateMany).not.toHaveBeenCalled();
  });
});

describe('DomainsService sub-domain writes', () => {
  it('creates a sub-domain, mapping a duplicate code to a conflict', async () => {
    const { prisma, svc } = setup();
    prisma.domain.findUnique.mockResolvedValue(row());
    prisma.subDomain.create.mockResolvedValueOnce(sub());
    await svc.createSubDomain('d1', { code: 'WS', name: 'n', nameAr: 'a' } as never);
    expect(prisma.subDomain.create.mock.calls[0]![0].data.displayOrder).toBe(0);
    prisma.subDomain.create.mockRejectedValueOnce(dup());
    await expect(
      svc.createSubDomain('d1', { code: 'WS', name: 'n', nameAr: 'a', displayOrder: 3 } as never),
    ).rejects.toThrow(code('SUBDOMAIN_CODE_ALREADY_EXISTS'));
  });

  it('updates a sub-domain and refuses one that is missing or under another domain', async () => {
    const { prisma, svc } = setup();
    prisma.subDomain.findUnique.mockResolvedValue(sub());
    prisma.subDomain.update.mockResolvedValueOnce(sub({ name: 'X' }));
    expect((await svc.updateSubDomain('d1', 's1', { name: 'X' } as never)).name).toBe('X');
    prisma.subDomain.update.mockRejectedValueOnce(dup());
    await expect(svc.updateSubDomain('d1', 's1', {} as never)).rejects.toThrow(
      code('SUBDOMAIN_CODE_ALREADY_EXISTS'),
    );
    await expect(svc.updateSubDomain('other', 's1', {} as never)).rejects.toThrow(
      code('SUBDOMAIN_NOT_FOUND'),
    );
    prisma.subDomain.findUnique.mockResolvedValueOnce(null);
    await expect(svc.updateSubDomain('d1', 'x', {} as never)).rejects.toThrow(
      code('SUBDOMAIN_NOT_FOUND'),
    );
  });

  it('will not reactivate a sub-domain under an inactive domain', async () => {
    const { prisma, svc } = setup();
    prisma.subDomain.findUnique.mockResolvedValue(sub({ isActive: false }));
    prisma.subDomain.update.mockResolvedValue(sub());
    prisma.domain.findUnique.mockResolvedValueOnce(row({ isActive: false }));
    await expect(svc.setSubDomainActive('d1', 's1', true)).rejects.toThrow(
      code('PARENT_DOMAIN_INACTIVE'),
    );
    prisma.domain.findUnique.mockResolvedValueOnce(row());
    await svc.setSubDomainActive('d1', 's1', true);
    await svc.setSubDomainActive('d1', 's1', false);
    expect(prisma.subDomain.update).toHaveBeenCalledTimes(2);
  });
});
