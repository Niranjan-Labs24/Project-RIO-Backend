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

  // Read-only, for Organization Settings' Consent card. `consent_acceptances`
  // is RLS-scoped by org_id, so this goes through the ambient org context
  // (the caller's own org) — never another organisation's acceptance record.
  async getOrganizationStatus(): Promise<OrganizationConsentStatus> {
    const latest = await this.tenant.runInOrgContext((tx) =>
      tx.consentAcceptance.findFirst({
        orderBy: { acceptedAt: 'desc' },
        include: { user: { select: { name: true, email: true } } },
      }),
    );
    if (!latest) {
      return { version: null, acceptedAt: null, acceptedByName: null, acceptedByEmail: null };
    }
    return {
      version: latest.policyVersion,
      acceptedAt: latest.acceptedAt.toISOString(),
      acceptedByName: latest.user.name,
      acceptedByEmail: latest.user.email,
    };
  }
}
