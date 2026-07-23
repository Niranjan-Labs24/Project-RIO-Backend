import { Controller, Get, Query } from '@nestjs/common';
import { Public } from '../../auth/public.decorator';
import { GeographyService } from './geography.service';
import type { Center, Governorate, Region } from './geography.types';

// No @RequirePermission on any route here, deliberately — same reasoning as
// OrganizationsController#getCurrent: this is read-only reference data
// (Region/Governorate/Center pickers), which every authenticated role needs
// for ordinary operational use, not an entityTeam/admin concern. @Public()
// on top of that because the signup form's own Region/Governorate/Center
// pickers (see signup-form.tsx) call these exact routes before an account
// exists — JwtAuthGuard now hard-blocks any non-@Public() route with no
// session, so without this, signup silently loses all geography data.
@Controller()
@Public()
export class GeographyController {
  constructor(private readonly geography: GeographyService) {}

  @Get('regions')
  listRegions(): Promise<Region[]> {
    return this.geography.listRegions();
  }

  @Get('governorates')
  listGovernorates(@Query('regionId') regionId?: string): Promise<Governorate[]> {
    return this.geography.listGovernorates(regionId || undefined);
  }

  @Get('centers')
  listCenters(@Query('governorateId') governorateId?: string): Promise<Center[]> {
    return this.geography.listCenters(governorateId || undefined);
  }
}
