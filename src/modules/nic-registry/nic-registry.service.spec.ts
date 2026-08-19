import { vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { NicRegistryService } from './nic-registry.service';

const KNOWN = '7011038218';

function makeService(known: string[] = [KNOWN]) {
  const findUnique = vi.fn(async ({ where }: { where: { nicNumber: string } }) =>
    known.includes(where.nicNumber) ? { id: 'nic-row-1' } : null,
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

  it('never throws for input a registrant could type', async () => {
    const { service } = makeService();
    await expect(service.check('')).resolves.toMatchObject({ verified: false });
  });

  it('returns no registry data beyond the verdict', async () => {
    // The button confirms a number the caller already has; it must not turn
    // the register into something readable through the API.
    const { service } = makeService();
    const result = await service.check(KNOWN);
    expect(Object.keys(result).sort()).toEqual(['nicNumber', 'verified']);
  });
});
