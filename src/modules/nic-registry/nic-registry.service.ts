import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NIC_NUMBER_PATTERN, normalizeNicNumber } from './nic-number.util';

// `nic_registry` is a global reference table (no org_id, no RLS — same
// pattern as regions/governorates/centers), seeded from
// Entities_Supervisory_Units.xlsx via prisma/import-nic-registry.ts.
// Read-only here: the app never writes to it, a re-import does.
@Injectable()
export class NicRegistryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Signup gate: the registration number an applicant types must be the NIC
   * number of an entity in the published registry.
   *
   * Returns the normalized 10-digit value, which is what the caller must
   * persist — storing the canonical form is what keeps
   * `organisations.registration_number`'s unique index from being defeated by
   * a dash or a stray space.
   *
   * Deliberately two distinct error codes: "you typed something that isn't a
   * NIC number at all" and "that is a well-formed number we don't have" are
   * different problems for the registrant, and the frontend localizes each.
   */
  async assertRegistered(raw: string): Promise<string> {
    const { nicNumber, reason } = await this.check(raw);

    if (reason === 'INVALID_FORMAT') {
      throw new BadRequestException({
        error: {
          code: 'REGISTRATION_NUMBER_INVALID',
          message: 'Registration number must be the 10-digit unified national number of your entity.',
        },
      });
    }

    if (reason === 'NOT_FOUND') {
      throw new BadRequestException({
        error: {
          code: 'REGISTRATION_NUMBER_NOT_RECOGNISED',
          message:
            'This registration number was not found in the national entity registry. ' +
            "Please check your entity's unified national number and try again.",
        },
      });
    }

    return nicNumber;
  }

  /**
   * Non-throwing form, behind POST /auth/verify-registration-number — the
   * "Verify" button next to the field on the signup form calls this so a
   * registrant finds out their number is wrong before filling in the rest of
   * a long form, rather than on submit.
   *
   * Returns only a verdict, never the entity's name or any other registry
   * column: the button confirms a number the caller already has, it is not a
   * lookup service for the register.
   */
  async check(raw: string): Promise<{
    nicNumber: string;
    verified: boolean;
    reason?: 'INVALID_FORMAT' | 'NOT_FOUND';
  }> {
    const nicNumber = normalizeNicNumber(raw);

    if (!NIC_NUMBER_PATTERN.test(nicNumber)) {
      return { nicNumber, verified: false, reason: 'INVALID_FORMAT' };
    }

    const match = await this.prisma.nicRegistry.findUnique({
      where: { nicNumber },
      select: { id: true },
    });

    return match
      ? { nicNumber, verified: true }
      : { nicNumber, verified: false, reason: 'NOT_FOUND' };
  }
}
