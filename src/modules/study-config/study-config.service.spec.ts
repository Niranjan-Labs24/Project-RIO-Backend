import { describe, expect, it, vi } from 'vitest';
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
    kind: 'Study Type',
  },
  {
    delegate: 'needThemeOption',
    list: 'listNeedThemes',
    names: 'listActiveNeedThemeNames',
    create: 'createNeedTheme',
    update: 'updateNeedTheme',
    active: 'setNeedThemeActive',
    kind: 'Need Theme',
  },
  {
    delegate: 'targetSectorOption',
    list: 'listTargetSectors',
    names: 'listActiveTargetSectorNames',
    create: 'createTargetSector',
    update: 'updateTargetSector',
    active: 'setTargetSectorActive',
    kind: 'Target Sector',
  },
  {
    delegate: 'decisionTypeOption',
    list: 'listDecisionTypes',
    names: 'listActiveDecisionTypeNames',
    create: 'createDecisionType',
    update: 'updateDecisionType',
    active: 'setDecisionTypeActive',
    kind: 'Decision Type',
  },
  {
    delegate: 'gapTypeOption',
    list: 'listGapTypes',
    names: 'listActiveGapTypeNames',
    create: 'createGapType',
    update: 'updateGapType',
    active: 'setGapTypeActive',
    kind: 'Gap Type',
  },
] as const;

describe.each(LISTS)(
  'StudyConfigService $delegate',
  ({ delegate, list, names, create, update, active, kind }) => {
    const setup = () => {
      const prisma = makeFakeTx();
      const audit = { record: vi.fn().mockResolvedValue(undefined) };
      // update()/setActive() both look the row up first (RIO-NFR-014's
      // before/after diff needs a real "before") — default it to an existing
      // row so tests that don't care about the not-found path don't need to
      // stub this every time.
      prisma[delegate].findUnique.mockResolvedValue(row());
      return { prisma, audit, svc: new StudyConfigService(prisma as never, audit as never) as any };
    };

    it('lists all options and the active names', async () => {
      const { prisma, svc } = setup();
      prisma[delegate].findMany.mockResolvedValue([row()]);
      expect(await svc[list]()).toEqual([row()]);
      expect(await svc[names]()).toEqual(['Name']);
    });

    it('creates an option, records an audit entry, mapping a duplicate name to a conflict and passing other errors on', async () => {
      const { prisma, audit, svc } = setup();
      prisma[delegate].create.mockResolvedValueOnce(row());
      expect(await svc[create]({ name: 'Name' })).toEqual(row());
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'create',
          entityType: 'study_config_option',
          entityId: 'o1',
          entityLabel: `${kind}: Name`,
        }),
      );
      prisma[delegate].create.mockRejectedValueOnce(known('P2002'));
      await expect(svc[create]({ name: 'Name' })).rejects.toThrow(code('OPTION_NAME_TAKEN'));
      const other = new Error('boom');
      prisma[delegate].create.mockRejectedValueOnce(other);
      await expect(svc[create]({ name: 'Name' })).rejects.toBe(other);
    });

    it('rejects updating an option that does not exist, without ever calling update()', async () => {
      const { prisma, audit, svc } = setup();
      prisma[delegate].findUnique.mockResolvedValueOnce(null);
      await expect(svc[update]('missing', { name: 'N' })).rejects.toThrow(code('OPTION_NOT_FOUND'));
      expect(prisma[delegate].update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('updates an option, records an audit entry with the real before/after values, mapping duplicate and missing rows and passing other errors on', async () => {
      const { prisma, audit, svc } = setup();
      prisma[delegate].findUnique.mockResolvedValue(row({ name: 'Old Name', displayOrder: 1 }));
      prisma[delegate].update.mockResolvedValueOnce(row({ name: 'N', displayOrder: 1 }));
      await svc[update]('o1', { name: 'N' });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'edit',
          entityType: 'study_config_option',
          entityId: 'o1',
          entityLabel: `${kind}: N`,
          changes: [{ field: 'Name', before: 'Old Name', after: 'N' }],
        }),
      );
      prisma[delegate].update.mockRejectedValueOnce(known('P2002'));
      await expect(svc[update]('o1', { name: 'N' })).rejects.toThrow(code('OPTION_NAME_TAKEN'));
      // A race: the row existed at the findUnique check above but is gone by
      // the time update() runs. Still mapped to OPTION_NOT_FOUND, same as the
      // findUnique-returns-null path above, just via a different code path.
      prisma[delegate].update.mockRejectedValueOnce(known('P2025'));
      await expect(svc[update]('o1', {})).rejects.toThrow(code('OPTION_NOT_FOUND'));
      const unmapped = known('P9999');
      prisma[delegate].update.mockRejectedValueOnce(unmapped);
      await expect(svc[update]('o1', {})).rejects.toBe(unmapped);
      const plain = new Error('boom');
      prisma[delegate].update.mockRejectedValueOnce(plain);
      await expect(svc[update]('o1', {})).rejects.toBe(plain);
    });

    it('rejects activating/deactivating an option that does not exist, without ever calling update()', async () => {
      const { prisma, audit, svc } = setup();
      prisma[delegate].findUnique.mockResolvedValueOnce(null);
      await expect(svc[active]('missing', true)).rejects.toThrow(code('OPTION_NOT_FOUND'));
      expect(prisma[delegate].update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('activates or deactivates an option, records an audit entry with the real before value, mapping a missing row', async () => {
      const { prisma, audit, svc } = setup();
      prisma[delegate].findUnique.mockResolvedValue(row({ isActive: true }));
      prisma[delegate].update.mockResolvedValueOnce(row({ isActive: false }));
      expect((await svc[active]('o1', false)).isActive).toBe(false);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'edit',
          entityType: 'study_config_option',
          entityId: 'o1',
          changes: [{ field: 'Active', before: true, after: false }],
        }),
      );
      prisma[delegate].update.mockRejectedValueOnce(known('P2025'));
      await expect(svc[active]('o1', true)).rejects.toThrow(code('OPTION_NOT_FOUND'));
      const plain = new Error('boom');
      prisma[delegate].update.mockRejectedValueOnce(plain);
      await expect(svc[active]('o1', true)).rejects.toBe(plain);
    });
  },
);
