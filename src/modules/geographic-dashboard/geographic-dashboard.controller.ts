import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { GeographicDashboardService } from './geographic-dashboard.service';
import {
  GEO_LEVELS,
  GEO_ITEM_KINDS,
  type GeoLevel,
  type GeoItemKind,
  type GeoMapResponse,
  type GeoPointItemsResponse,
} from './geographic-dashboard.types';

@Controller('geographic-dashboard')
export class GeographicDashboardController {
  constructor(private readonly dashboard: GeographicDashboardService) {}

  /**
   * RIO-FR-008 — needs aggregated onto map points.
   *
   * `level` defaults to center, the finest grain the client's geographic
   * reference goes to. Region and governorate roll the same needs up for a
   * coarser read.
   */
  @Get('map')
  @RequirePermission('reportsDashboards', 'read')
  getMap(
    @Query('level') level = 'center',
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

  /**
   * The rows behind one point's figures, for the map panel's drill-down.
   *
   * Takes the same level and filter params as `map` on purpose: the panel is
   * showing a point from a specific filtered view, and a list that quietly
   * ignored the active filters would not match the count the reader clicked.
   *
   * Same permission as `map` — this is the same data at a finer grain, not a
   * wider disclosure, and gating it separately would let a reader see a count
   * they cannot open.
   */
  @Get('points/:pointId/items')
  @RequirePermission('reportsDashboards', 'read')
  getPointItems(
    @Param('pointId') pointId: string,
    @Query('level') level = 'center',
    @Query('kind') kind = 'needs',
    @Query('sector') sector?: string,
    @Query('urgency') urgency?: string,
    @Query('status') status?: string,
  ): Promise<GeoPointItemsResponse> {
    if (!(GEO_LEVELS as readonly string[]).includes(level)) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_GEO_LEVEL',
          message: `level must be one of ${GEO_LEVELS.join(', ')}.`,
        },
      });
    }
    if (!(GEO_ITEM_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_GEO_ITEM_KIND',
          message: `kind must be one of ${GEO_ITEM_KINDS.join(', ')}.`,
        },
      });
    }
    return this.dashboard.getPointItems(pointId, level as GeoLevel, kind as GeoItemKind, {
      sector,
      urgency,
      status,
    });
  }
}
