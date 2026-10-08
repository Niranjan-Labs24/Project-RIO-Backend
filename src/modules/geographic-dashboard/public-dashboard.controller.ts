import { Controller, Get } from '@nestjs/common';
import { Public } from '../../auth/public.decorator';
import { PublicDashboardService } from './public-dashboard.service';
import type { PublicDashboardResponse } from './public-dashboard.types';

/**
 * The landing page's public dashboard — averages per region, governorate and
 * domain, open to anyone.
 *
 * `@Public()` sits on the class, so every method here is on the open
 * internet. Keep it to this one GET of totals: anything that names a need,
 * an organisation or a place below governorate belongs behind login in
 * GeographicDashboardController.
 */
@Public()
@Controller('public/dashboard')
export class PublicDashboardController {
  constructor(private readonly dashboard: PublicDashboardService) {}

  @Get()
  get(): Promise<PublicDashboardResponse> {
    return this.dashboard.get();
  }
}
