import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { ConsentService } from './consent.service';
import type { ActiveConsentPolicy, OrganizationConsentStatus } from './consent.types';

@Controller('consent-policy')
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  // Open route (no @RequirePermission): the signup screen needs the policy
  // text + version before the caller has any account/session at all.
  @Get('active')
  getActive(): Promise<ActiveConsentPolicy> {
    return this.consent.getActivePolicy();
  }

  // Authenticated — read-only Consent card on Organization Settings
  // (version / accepted date / accepted by), scoped to the caller's own org.
  @Get('organization-status')
  @RequirePermission('entityTeam', 'read')
  getOrganizationStatus(): Promise<OrganizationConsentStatus> {
    return this.consent.getOrganizationStatus();
  }
}
