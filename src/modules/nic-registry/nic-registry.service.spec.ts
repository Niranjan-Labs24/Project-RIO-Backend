import { vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { NicRegistryService } from './nic-registry.service';

const KNOWN = '7011038218';
const NAME_EN = 'Literary in Riyadh';
const NAME_AR = 'جمعية الأدب في الرياض';

function makeService(known: string[] = [KNOWN], names: { nameEn: string | null; nameAr: string | null } = { nameEn: NAME_EN, nameAr: NAME_AR }) {
  const findUnique = vi.fn(async ({ where }: { where: { nicNumber: string } }) =>
    known.includes(where.nicNumber) ? { id: 'nic-row-1', ...names } : null,
  );
  const service = new NicRegistryService({ nicRegistry: { findUnique } } as never);
  return { service, findUnique };
}

describe('NicRegistryService.assertRegistered', () => {
  it('accepts a registration number present in the registry and returns it normalized', async () => {
    const { service } = makeService();
    await expect(service.assertRegistered(KNOWN)).resolves.toBe(KNOWN);
  });

  it('accepts the same number typed with separators or Arabic-Indic digits', async () => {
    const { service, findUnique } = makeService();

    await expect(service.assertRegistered(' 7011-038-218 ')).resolves.toBe(KNOWN);
    await expect(service.assertRegistered('٧٠١١٠٣٨٢١٨')).resolves.toBe(KNOWN);
    // The DB is only ever queried with the canonical form.
    for (const call of findUnique.mock.calls) {
      expect(call[0].where.nicNumber).toBe(KNOWN);
    }
  });

  it('rejects a well-formed number that is not in the registry', async () => {
    const { service } = makeService();
    await expect(service.assertRegistered('9999999999')).rejects.toMatchObject({
      response: { error: { code: 'REGISTRATION_NUMBER_NOT_RECOGNISED' } },
    });
  });

  it.each([['too short', '701103821'], ['too long', '70110382180'], ['not digits', 'NGO123456'], ['empty', '']])(
    'rejects a %s registration number before querying the registry',
    async (_label, input) => {
      const { service, findUnique } = makeService();
      await expect(service.assertRegistered(input)).rejects.toMatchObject({
        response: { error: { code: 'REGISTRATION_NUMBER_INVALID' } },
      });
      // Shape is checked first — a malformed value never reaches the DB.
      expect(findUnique).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['the English name', NAME_EN],
    ['the English name in a different case', 'LITERARY IN riyadh'],
    ['the English name with extra whitespace', '  Literary   in Riyadh '],
    ['the Arabic name', NAME_AR],
  ])('accepts the number together with %s', async (_label, name) => {
    const { service } = makeService();
    await expect(service.assertRegistered(KNOWN, name)).resolves.toBe(KNOWN);
  });

  it.each([
    ['a different name', 'Some Other Entity'],
    ['a partial name', 'Literary'],
    ['a blank name', '   '],
  ])('rejects the number together with %s', async (_label, name) => {
    const { service } = makeService();
    await expect(service.assertRegistered(KNOWN, name)).rejects.toMatchObject({
      response: { error: { code: 'ORGANIZATION_NAME_MISMATCH' } },
    });
  });

  it('never matches a name against an empty registry column', async () => {
    const { service } = makeService([KNOWN], { nameEn: null, nameAr: NAME_AR });
    await expect(service.assertRegistered(KNOWN, '')).rejects.toMatchObject({
      response: { error: { code: 'ORGANIZATION_NAME_MISMATCH' } },
    });
    await expect(service.assertRegistered(KNOWN, NAME_AR)).resolves.toBe(KNOWN);
  });

  it('still reports an unknown number as NOT_RECOGNISED when a name is given', async () => {
    const { service } = makeService();
    await expect(service.assertRegistered('9999999999', NAME_EN)).rejects.toMatchObject({
      response: { error: { code: 'REGISTRATION_NUMBER_NOT_RECOGNISED' } },
    });
  });

  it('throws 400s, so the frontend can map them onto the field', async () => {
    const { service } = makeService();
    await expect(service.assertRegistered('9999999999')).rejects.toBeInstanceOf(BadRequestException);
  });
});

// The non-throwing form behind the signup form's "Verify" button.
describe('NicRegistryService.check', () => {
  it('verifies a registered number and reports the normalized value', async () => {
    const { service } = makeService();
    await expect(service.check(' 7011-038-218 ')).resolves.toEqual({
      nicNumber: KNOWN,
      verified: true,
    });
  });

  it('distinguishes "not in the registry" from "not a NIC number at all"', async () => {
    const { service } = makeService();
    await expect(service.check('9999999999')).resolves.toMatchObject({
      verified: false,
      reason: 'NOT_FOUND',
    });
    await expect(service.check('NGO123456')).resolves.toMatchObject({
      verified: false,
      reason: 'INVALID_FORMAT',
    });
  });

  it('reports NAME_MISMATCH for a known number paired with the wrong name', async () => {
    const { service } = makeService();
    await expect(service.check(KNOWN, 'Wrong Name')).resolves.toMatchObject({
      verified: false,
      reason: 'NAME_MISMATCH',
    });
    await expect(service.check(KNOWN, 'literary in riyadh')).resolves.toEqual({
      nicNumber: KNOWN,
      verified: true,
    });
  });

  it('never throws for input a registrant could type', async () => {
    const { service } = makeService();
    await expect(service.check('')).resolves.toMatchObject({ verified: false });
  });

  it('returns no registry data beyond the verdict', async () => {
    // The button confirms a number the caller already has; it must not turn
    // the register into something readable through the API.
    const { service } = makeService();
    const result = await service.check(KNOWN, 'Wrong Name');
    expect(Object.keys(result).sort()).toEqual(['nicNumber', 'reason', 'verified']);
    expect(JSON.stringify(result)).not.toContain(NAME_EN);
    expect(JSON.stringify(result)).not.toContain(NAME_AR);
  });
});
