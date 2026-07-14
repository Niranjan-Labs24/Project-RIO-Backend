import { ConflictException, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { Prisma, UserStatus } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';

export interface CreateOrgAdminInput {
  organizationName: string;
  purpose: string;
  registrationNumber: string;
  email: string;
  passwordHash: string;
  now: Date;
}

export function generateTemporaryPassword(): string {
  return randomBytes(9).toString('base64url');
}

export function conflictFor(field: 'registrationNumber' | 'email'): ConflictException {
  return field === 'registrationNumber'
    ? new ConflictException({ error: { code: 'ORGANIZATION_ALREADY_REGISTERED', message: 'An organization with this registration number already exists.' } })
    : new ConflictException({ error: { code: 'EMAIL_ALREADY_REGISTERED', message: 'An account with this email already exists.' } });
}

function uniqueField(err: unknown): 'registrationNumber' | 'email' | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const t = err.meta?.['target'];
    const target = Array.isArray(t) ? t.join(',') : String(t ?? '');
    if (target.includes('registration_number')) return 'registrationNumber';
    if (target.includes('email')) return 'email';
  }
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
          data: { id: orgId, name: input.organizationName, purpose: input.purpose, registrationNumber: input.registrationNumber },
        });
        const user = await tx.user.create({
          data: {
            orgId,
            roleId: 'role_ngo_admin',
            name: `${input.organizationName} Admin`,
            email: input.email,
            status: UserStatus.active,
            passwordHash: input.passwordHash,
            mustChangePassword: true,
            consentedAt: input.now,
          },
        });
        const policy = await tx.consentPolicy.findFirst({ where: { active: true }, orderBy: { createdAt: 'desc' } });
        if (policy) {
          await tx.consentAcceptance.create({
            data: { orgId, userId: user.id, policyVersion: policy.version, policyText: policy.text, acceptedAt: input.now },
          });
        }
        return { org, user };
      });
    } catch (err) {
      const field = uniqueField(err);
      if (field) throw conflictFor(field);
      throw err;
    }
  }
}
