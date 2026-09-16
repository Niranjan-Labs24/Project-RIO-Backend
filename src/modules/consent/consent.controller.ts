import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { Public } from '../../auth/public.decorator';
import {
  CreateConsentPolicyBody,
  ReviewConsentPolicyBody,
  UpdateConsentPolicyBody,
} from './consent.contract';
import type {
  CreateConsentPolicyDto,
  ReviewConsentPolicyDto,
  UpdateConsentPolicyDto,
} from './consent.contract';
import { ConsentService } from './consent.service';
import type {
  ActiveConsentPolicies,
  ActiveConsentPolicy,
  ConsentPolicyVersion,
  ConsentPolicyVersionList,
  OrganizationConsentStatus,
} from './consent.types';

@Controller('consent-policy')
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  // Open route (no @RequirePermission): the signup screen needs both policy
  // texts + versions before the caller has any account/session at all —
  // RIO-DATA-001 requires consent to be given during registration, so this
  // has to be reachable by an anonymous caller.
  @Get('active')
  @Public()
  getActive(): Promise<ActiveConsentPolicies> {
    return this.consent.getActivePolicies();
  }

  // Open route, same reasoning as `active` above and then some: the citizen
  // survey screen is wholly unauthenticated (see CitizenController's @Public),
  // and RIO-NFR-002 requires the notice to be read and accepted before any
  // personal detail is collected — so it must be fetchable by a caller who
  // will never have an account.
  @Get('citizen')
  @Public()
  getActiveCitizenPolicy(): Promise<ActiveConsentPolicy> {
    return this.consent.getActiveCitizenPolicy();
  }

  // Authenticated — read-only Consent card on Organization Settings
  // (per-consent version / accepted date, plus who accepted), scoped to the
  // caller's own org.
  @Get('organization-status')
  @RequirePermission('entityTeam', 'read')
  getOrganizationStatus(): Promise<OrganizationConsentStatus> {
    return this.consent.getOrganizationStatus();
  }

  // ───────────── Consent Policies tab, Methodology Configuration
  //
  // Client-confirmed (2026-08-27): consent text is managed dynamically and
  // versioned rather than hardcoded per release. The RBAC split below is the
  // client's own — System Admin "drafts, creates, and updates policy
  // versions" (`onboardingConsent:create`/`write`) and System Reviewer "gives
  // final sign-off before it's published" (`onboardingConsent:approve`) —
  // and the role matrix already carried exactly those grants, so no RBAC
  // change was needed to wire this up.
  //
  // `read` is the module's broadly-granted bit, so every role that can see
  // Methodology Configuration can read the version history; only the two
  // roles above can move a version through it.

  @Get('versions')
  @RequirePermission('onboardingConsent', 'read')
  listVersions(): Promise<ConsentPolicyVersionList> {
    return this.consent.listVersions();
  }

  @Post('versions')
  @RequirePermission('onboardingConsent', 'create')
  createDraft(
    @Body(new TypeBoxValidationPipe(CreateConsentPolicyBody)) body: CreateConsentPolicyDto,
  ): Promise<ConsentPolicyVersion> {
    return this.consent.createDraft(body);
  }

  @Patch('versions/:id')
  @RequirePermission('onboardingConsent', 'write')
  updateDraft(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(UpdateConsentPolicyBody)) body: UpdateConsentPolicyDto,
  ): Promise<ConsentPolicyVersion> {
    return this.consent.updateDraft(id, body);
  }

  @Post('versions/:id/submit')
  @RequirePermission('onboardingConsent', 'write')
  submitForApproval(@Param('id', new UuidParamPipe()) id: string): Promise<ConsentPolicyVersion> {
    return this.consent.submitForApproval(id);
  }

  // System Reviewer only — mandatory notes on both outcomes.
  @Patch('versions/:id/approve')
  @RequirePermission('onboardingConsent', 'approve')
  approveVersion(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(ReviewConsentPolicyBody)) body: ReviewConsentPolicyDto,
  ): Promise<ConsentPolicyVersion> {
    return this.consent.approveVersion(id, body.notes);
  }

  @Patch('versions/:id/reject')
  @RequirePermission('onboardingConsent', 'approve')
  rejectVersion(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(ReviewConsentPolicyBody)) body: ReviewConsentPolicyDto,
  ): Promise<ConsentPolicyVersion> {
    return this.consent.rejectVersion(id, body.notes);
  }

  // System Admin publishes what the Reviewer approved — the same
  // approve-then-publish split as the NCNP Compiled Report and Methodology
  // Configuration, so no one role can both author and release policy text.
  @Post('versions/:id/publish')
  @RequirePermission('onboardingConsent', 'write')
  publishVersion(@Param('id', new UuidParamPipe()) id: string): Promise<ConsentPolicyVersion> {
    return this.consent.publishVersion(id);
  }
}
