import { ConflictException, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { Prisma, UserStatus } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';

export interface CreateOrgAdminInput {
  organizationName: string;
  sector?: string;
  purpose?: string;
  registrationNumber: string;
  email: string;
  passwordHash: string;
  regionId: string;
  governorateIds: string[];
  centerIds: string[];
}

export function generateTemporaryPassword(): string {
  return randomBytes(9).toString('base64url');
}

export function conflictFor(field: 'registrationNumber' | 'email'): ConflictException {
  return field === 'registrationNumber'
    ? new ConflictException({ error: { code: 'ORGANIZATION_ALREADY_REGISTERED', message: 'An organization with this registration number already exists.' } })
    : new ConflictException({ error: { code: 'EMAIL_ALREADY_REGISTERED', message: 'An account with this email already exists.' } });
}

// Exported so other create paths that hit the same org/user unique
// constraints (e.g. OrganizationsService.createWithAdmin) can map a Prisma
// P2002 to the same clean 409 envelope via conflictFor().
export function uniqueField(err: unknown): 'registrationNumber' | 'email' | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return null;
  // Prisma's binary engine reports the offending column(s) in `meta.target`,
  // but the pg driver adapter (Prisma 7) leaves that undefined and instead
  // nests the raw Postgres message — which carries the constraint name, e.g.
  // `organisations_registration_number_key` / `users_email_key` — under
  // `meta.driverAdapterError.cause.originalMessage`. Check both shapes.
  const meta = (err.meta ?? {}) as {
    target?: unknown;
    driverAdapterError?: { cause?: { originalMessage?: unknown } };
  };
  const fromTarget = Array.isArray(meta.target) ? meta.target.join(',') : String(meta.target ?? '');
  const fromAdapter = String(meta.driverAdapterError?.cause?.originalMessage ?? '');
  const haystack = `${fromTarget} ${fromAdapter}`;
  if (haystack.includes('registration_number')) return 'registrationNumber';
  if (haystack.includes('email')) return 'email';
  return null;
}

@Injectable()
export class AuthRepository {
  constructor(private readonly tenant: TenantPrismaService) {}

  // Pre-context reads (no org yet) via the SELECT-only supervisor client.
  findByRegistrationNumber(registrationNumber: string) {
    return this.tenant.runAsSupervisor((tx) => tx.organisation.findFirst({ where: { registrationNumber } }));
  }

  findUserByEmail(email: string) {
    return this.tenant.runAsSupervisor((tx) => tx.user.findUnique({ where: { email } }));
  }

  async createOrganisationAndAdmin(input: CreateOrgAdminInput) {
    const orgId = uuidv7();
    try {
      return await this.tenant.runAsOrg(orgId, async (tx) => {
        const org = await tx.organisation.create({
          data: {
            id: orgId, name: input.organizationName, purpose: input.purpose,
            sector: input.sector ?? null,
            registrationNumber: input.registrationNumber, email: input.email,
            regionId: input.regionId,
            // Nested under the parent create — orgId is implied by the
            // relation, not a field Prisma accepts here (unlike the
            // standalone tx.organisationGovernorate.createMany() calls
            // OrganizationsService.updateCurrent makes later, where it's
            // required since there's no parent create to imply it).
            orgGovernorates: {
              createMany: { data: input.governorateIds.map((governorateId) => ({ governorateId })) },
            },
            orgCenters: {
              createMany: { data: input.centerIds.map((centerId) => ({ centerId })) },
            },
          },
        });
        // Consent is captured after first login (post password-reset), not
        // here — see AuthService.consent() / the frontend's ConsentGuard.
        // `consentedAt` stays null, same as an invited user starts out.
        const user = await tx.user.create({
          data: {
            orgId,
            roleId: 'role_ngo_admin',
            name: `${input.organizationName} Admin`,
            email: input.email,
            status: UserStatus.active,
            passwordHash: input.passwordHash,
            mustChangePassword: true,
          },
        });
        // Just-created above — no join rows to fetch, build them straight
        // from the input the same shape buildSession()/toOrgRow() expect
        // (see OrganizationsService.createWithAdmin's identical pattern).
        const orgWithGeo = {
          ...org,
          orgGovernorates: input.governorateIds.map((governorateId) => ({ governorateId })),
          orgCenters: input.centerIds.map((centerId) => ({ centerId })),
        };
        return { org: orgWithGeo, user };
      });
    } catch (err) {
      const field = uniqueField(err);
      if (field) throw conflictFor(field);
      throw err;
    }
  }
}
