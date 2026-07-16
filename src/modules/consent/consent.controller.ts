import { Controller, Get } from '@nestjs/common';
import { ConsentService } from './consent.service';
import type { ActiveConsentPolicy } from './consent.types';

@Controller('consent-policy')
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  // Open route (no @RequirePermission): the signup screen needs the policy
  // text + version before the caller has any account/session at all.
  @Get('active')
  getActive(): Promise<ActiveConsentPolicy> {
    return this.consent.getActivePolicy();
  }
}
