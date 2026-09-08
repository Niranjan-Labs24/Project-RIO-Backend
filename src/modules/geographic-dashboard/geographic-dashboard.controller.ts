import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { GeographicDashboardService } from './geographic-dashboard.service';
import {
  GEO_LEVELS,
  type GeoLevel,
  type GeoMapResponse,
} from './geographic-dashboard.types';

@Controller('geographic-dashboard')
export class GeographicDashboardController {
  constructor(private readonly dashboard: GeographicDashboardService) {}

  /**
   * RIO-FR-008 — needs aggregated onto map points.
   *
   * `level` defaults to governorate, which is the finest grain that has
   * coordinates today. Passing `center` is already supported and starts
   * returning points as soon as `centers.latitude` is seeded — no release
   * needed.
   */
  @Get('map')
  @RequirePermission('reportsDashboards', 'read')
  getMap(
    @Query('level') level = 'governorate',
    @Query('sector') sector?: string,
    @Query('urgency') urgency?: string,
    @Query('status') status?: string,
  ): Promise<GeoMapResponse> {
    if (!(GEO_LEVELS as readonly string[]).includes(level)) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_GEO_LEVEL',
          message: `level must be one of ${GEO_LEVELS.join(', ')}.`,
        },
      });
    }
    return this.dashboard.getMap(level as GeoLevel, { sector, urgency, status });
  }
}
