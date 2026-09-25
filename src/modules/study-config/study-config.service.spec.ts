import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma';
import { makeFakeTx } from '../../../test/support/fake-tx';
import { StudyConfigService } from './study-config.service';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  name: 'Name',
  nameAr: 'اسم',
  displayOrder: 1,
  isActive: true,
  ...over,
});
const known = (c: string) =>
  new Prisma.PrismaClientKnownRequestError('x', { code: c, clientVersion: 'x' });
const code = (c: string) =>
  expect.objectContaining({ response: { error: expect.objectContaining({ code: c }) } });

// Every option list shares one shape, so each is driven through the same checks.
const LISTS = [
  {
    delegate: 'studyTypeOption',
    list: 'listStudyTypes',
    names: 'listActiveStudyTypeNames',
    create: 'createStudyType',
    update: 'updateStudyType',
    active: 'setStudyTypeActive',
  },
  {
    delegate: 'needThemeOption',
    list: 'listNeedThemes',
    names: 'listActiveNeedThemeNames',
    create: 'createNeedTheme',
    update: 'updateNeedTheme',
    active: 'setNeedThemeActive',
  },
  {
    delegate: 'targetSectorOption',
    list: 'listTargetSectors',
    names: 'listActiveTargetSectorNames',
    create: 'createTargetSector',
    update: 'updateTargetSector',
    active: 'setTargetSectorActive',
  },
  {
    delegate: 'decisionTypeOption',
    list: 'listDecisionTypes',
    names: 'listActiveDecisionTypeNames',
    create: 'createDecisionType',
    update: 'updateDecisionType',
    active: 'setDecisionTypeActive',
  },
  {
    delegate: 'gapTypeOption',
    list: 'listGapTypes',
    names: 'listActiveGapTypeNames',
    create: 'createGapType',
    update: 'updateGapType',
    active: 'setGapTypeActive',
  },
] as const;

describe.each(LISTS)(
  'StudyConfigService $delegate',
  ({ delegate, list, names, create, update, active }) => {
    const setup = () => {
      const prisma = makeFakeTx();
      return { prisma, svc: new StudyConfigService(prisma as never) as any };
    };

    it('lists all options and the active names', async () => {
      const { prisma, svc } = setup();
      prisma[delegate].findMany.mockResolvedValue([row()]);
      expect(await svc[list]()).toEqual([row()]);
      expect(await svc[names]()).toEqual(['Name']);
    });

    it('creates an option, mapping a duplicate name to a conflict and passing other errors on', async () => {
      const { prisma, svc } = setup();
      prisma[delegate].create.mockResolvedValueOnce(row());
      expect(await svc[create]({ name: 'Name' })).toEqual(row());
      prisma[delegate].create.mockRejectedValueOnce(known('P2002'));
      await expect(svc[create]({ name: 'Name' })).rejects.toThrow(code('OPTION_NAME_TAKEN'));
      const other = new Error('boom');
      prisma[delegate].create.mockRejectedValueOnce(other);
      await expect(svc[create]({ name: 'Name' })).rejects.toBe(other);
    });

    it('updates an option, mapping duplicate and missing rows and passing other errors on', async () => {
      const { prisma, svc } = setup();
      prisma[delegate].update.mockResolvedValueOnce(row());
      await svc[update]('o1', { name: 'N' });
      prisma[delegate].update.mockRejectedValueOnce(known('P2002'));
      await expect(svc[update]('o1', { name: 'N' })).rejects.toThrow(code('OPTION_NAME_TAKEN'));
      prisma[delegate].update.mockRejectedValueOnce(known('P2025'));
      await expect(svc[update]('o1', {})).rejects.toThrow(code('OPTION_NOT_FOUND'));
      const unmapped = known('P9999');
      prisma[delegate].update.mockRejectedValueOnce(unmapped);
      await expect(svc[update]('o1', {})).rejects.toBe(unmapped);
      const plain = new Error('boom');
      prisma[delegate].update.mockRejectedValueOnce(plain);
      await expect(svc[update]('o1', {})).rejects.toBe(plain);
    });

    it('activates or deactivates an option, mapping a missing row', async () => {
      const { prisma, svc } = setup();
      prisma[delegate].update.mockResolvedValueOnce(row({ isActive: false }));
      expect((await svc[active]('o1', false)).isActive).toBe(false);
      prisma[delegate].update.mockRejectedValueOnce(known('P2025'));
      await expect(svc[active]('o1', true)).rejects.toThrow(code('OPTION_NOT_FOUND'));
      const plain = new Error('boom');
      prisma[delegate].update.mockRejectedValueOnce(plain);
      await expect(svc[active]('o1', true)).rejects.toBe(plain);
    });
  },
);
