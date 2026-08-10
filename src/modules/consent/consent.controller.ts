import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { Public } from '../../auth/public.decorator';
import { ConsentService } from './consent.service';
import type { ActiveConsentPolicies, OrganizationConsentStatus } from './consent.types';

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

  // Authenticated — read-only Consent card on Organization Settings
  // (per-consent version / accepted date, plus who accepted), scoped to the
  // caller's own org.
  @Get('organization-status')
  @RequirePermission('entityTeam', 'read')
  getOrganizationStatus(): Promise<OrganizationConsentStatus> {
    return this.consent.getOrganizationStatus();
  }
}
