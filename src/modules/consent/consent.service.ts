import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import type {
  ActiveConsentPolicies,
  ActiveConsentPolicy,
  ConsentKind,
  OrganizationConsentStatus,
} from './consent.types';

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

  /**
   * RIO-DATA-001 — the active version of one of the two consents. A missing
   * active policy is a 404 rather than a silent null: signup validates the
   * submitted version against this, so a misconfigured policy must fail
   * loudly at the point of misconfiguration, not let un-consented accounts
   * through.
   */
  async getActivePolicy(kind: ConsentKind): Promise<ActiveConsentPolicy> {
    const policy = await this.prisma.consentPolicy.findFirst({
      where: { kind, active: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!policy) {
      throw new NotFoundException({
        error: {
          code: 'NO_ACTIVE_CONSENT_POLICY',
          message: `No active ${kind === 'use_policy' ? 'use' : 'data-sharing'} consent policy is configured.`,
        },
      });
    }
    // Both languages travel together — the caller (public endpoint or signup
    // validation) picks one via consentPolicyTextFor. Serving a pre-resolved
    // single string would mean re-fetching on every language switch, and
    // would leave signup unable to check that the text it snapshots is the
    // text the browser rendered.
    return { kind, version: policy.version, text: policy.text, textAr: policy.textAr };
  }

  /** Both consents in one round-trip — what the registration form needs. */
  async getActivePolicies(): Promise<ActiveConsentPolicies> {
    const [usePolicy, dataSharing] = await Promise.all([
      this.getActivePolicy('use_policy'),
      this.getActivePolicy('data_sharing'),
    ]);
    return { usePolicy, dataSharing };
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
        select: {
          name: true,
          email: true,
          consentedAt: true,
          consentedPolicyVersion: true,
          sharingConsentedAt: true,
          sharingConsentedPolicyVersion: true,
        },
      }),
    );
    // The two consents are reported independently — an org that registered
    // before the data-sharing consent existed shows the use policy as
    // accepted and the sharing consent as outstanding, which is the honest
    // state and the one the consent gate acts on.
    return {
      usePolicy: {
        version: admin?.consentedAt ? admin.consentedPolicyVersion : null,
        acceptedAt: admin?.consentedAt?.toISOString() ?? null,
      },
      dataSharing: {
        version: admin?.sharingConsentedAt ? admin.sharingConsentedPolicyVersion : null,
        acceptedAt: admin?.sharingConsentedAt?.toISOString() ?? null,
      },
      // Attributed to the account owner, same as before — null only when no
      // admin row exists at all, not merely when a consent is outstanding.
      acceptedByName: admin?.name ?? null,
      acceptedByEmail: admin?.email ?? null,
    };
  }
}
