import { Controller, Get, Query } from '@nestjs/common';
import { GeographyService } from './geography.service';
import type { Center, Governorate, Region } from './geography.types';

// No @RequirePermission on any route here, deliberately — same reasoning as
// OrganizationsController#getCurrent: this is read-only reference data
// (Region/Governorate/Center pickers on Organization setup screens), which
// every authenticated role needs for ordinary operational use, not an
// entityTeam/admin concern. JwtAuthGuard (global) still requires a valid
// session.
@Controller()
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
