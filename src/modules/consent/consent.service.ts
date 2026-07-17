import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import type { ActiveConsentPolicy, OrganizationConsentStatus } from './consent.types';

// `consent_policies` is a global reference table (no RLS, plain SELECT grant
// — same as `roles`/`role_permissions`), so this reads via the bare
// PrismaService, no org context needed. Matches AuthRepository's own lookup
// of the active policy during signup.
@Injectable()
export class ConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
  ) {}

  async getActivePolicy(): Promise<ActiveConsentPolicy> {
    const policy = await this.prisma.consentPolicy.findFirst({
      where: { active: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!policy) {
      throw new NotFoundException({
        error: { code: 'NO_ACTIVE_CONSENT_POLICY', message: 'No active consent policy is configured.' },
      });
    }
    return { version: policy.version, text: policy.text };
  }

  // Read-only, for Organization Settings' Consent card — the org's own
  // consent record, meaning the NGO Admin's (account owner's) acceptance
  // specifically. NOT "whoever in this org accepted most recently": every
  // invited user (Research Officer, Reviewer, etc.) also accepts this same
  // policy as part of their own onboarding, and a naive "latest
  // ConsentAcceptance in the org" query would surface whichever of them
  // happened to onboard last, overwriting the admin's own acceptance in
  // this display even though nothing about the org's actual policy
  // acceptance changed.
  async getOrganizationStatus(): Promise<OrganizationConsentStatus> {
    const admin = await this.tenant.runInOrgContext((tx) =>
      tx.user.findFirst({
        where: { roleId: 'role_ngo_admin' },
        select: { name: true, email: true, consentedAt: true, consentedPolicyVersion: true },
      }),
    );
    if (!admin?.consentedAt) {
      return { version: null, acceptedAt: null, acceptedByName: null, acceptedByEmail: null };
    }
    return {
      version: admin.consentedPolicyVersion,
      acceptedAt: admin.consentedAt.toISOString(),
      acceptedByName: admin.name,
      acceptedByEmail: admin.email,
    };
  }
}
