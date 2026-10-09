import { Module } from '@nestjs/common';
import { GeographicDashboardController } from './geographic-dashboard.controller';
import { GeographicDashboardService } from './geographic-dashboard.service';
import { PublicDashboardController } from './public-dashboard.controller';
import { PublicDashboardService } from './public-dashboard.service';

// RIO-FR-008. TenantPrismaService comes from the @Global() tenancy module,
// so this needs no imports of its own.
@Module({
  controllers: [GeographicDashboardController, PublicDashboardController],
  providers: [GeographicDashboardService, PublicDashboardService],
})
export class GeographicDashboardModule {}
