import { ConflictException, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { ConsentPolicyKind, Prisma, UserStatus } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';

/**
 * RIO-DATA-001 — the resolved, server-side policy rows the registrant
 * accepted. AuthService loads these from `consent_policies` and checks the
 * submitted versions against them *before* calling the repository, so by
 * this point they are known-active policies, not client-supplied strings.
 */
export interface ConsentAcceptanceInput {
  kind: ConsentPolicyKind;
  version: string;
  text: string;
}

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
  // Both consents, accepted as part of registration itself.
  consents: ConsentAcceptanceInput[];
}

// TEMPORARY: the email provider's free-trial plan can only deliver to one
// pre-verified address, so a randomly generated temporary password is
// useless to anyone else — it can never reach the new user's inbox. Using
// this fixed, known password instead means every new account's first login
// works regardless of email delivery. The mandatory first-login password
// change still applies, so this is never a long-term credential. Every
// caller that provisions a temporary password (signup, user invite,
// resend-invite) shares this one constant so there's a single place to
// revert once a verified sending domain/paid plan is configured (see Known
// Limitations in the Functional Handover Guide) — at that point, switch
// back to generateTemporaryPassword() below.
export const DEFAULT_TEMP_PASSWORD = 'Welcome@123';

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
            // RIO-FR-010 (client-confirmed): self-registration requires
            // Center (System Admin) approval before activation —
            // approvedAt/approvedBy stay null until OrganizationsService.approve
            // is called; login() already rejects any user whose org isActive
            // is false (ORG_INACTIVE).
            isActive: false,
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
        // RIO-DATA-001 — consent is captured HERE, as part of registration
        // itself, not after first login: the admin's consent columns are
        // stamped on the row at creation and the immutable acceptance rows
        // are written in this same transaction, so an org can never exist
        // without both consents on record. If any of it fails, the whole
        // registration rolls back rather than leaving a half-consented org.
        const usePolicy = input.consents.find((c) => c.kind === ConsentPolicyKind.use_policy);
        const dataSharing = input.consents.find((c) => c.kind === ConsentPolicyKind.data_sharing);
        const consentedAt = new Date();
        const user = await tx.user.create({
          data: {
            orgId,
            roleId: 'role_ngo_admin',
            name: `${input.organizationName} Admin`,
            email: input.email,
            status: UserStatus.active,
            passwordHash: input.passwordHash,
            mustChangePassword: true,
            consentedAt: usePolicy ? consentedAt : null,
            consentedPolicyVersion: usePolicy?.version ?? null,
            sharingConsentedAt: dataSharing ? consentedAt : null,
            sharingConsentedPolicyVersion: dataSharing?.version ?? null,
          },
        });
        // Snapshot the exact text of each policy accepted — the acceptance
        // record has to stand on its own even after the policy text is
        // later edited or superseded.
        if (input.consents.length > 0) {
          await tx.consentAcceptance.createMany({
            data: input.consents.map((c) => ({
              orgId,
              userId: user.id,
              kind: c.kind,
              policyVersion: c.version,
              policyText: c.text,
              acceptedAt: consentedAt,
            })),
          });
        }
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
