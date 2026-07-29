import { Module } from '@nestjs/common';
import { NcnpReportController } from './ncnp-report.controller';
import { NcnpReportService } from './ncnp-report.service';

@Module({
  controllers: [NcnpReportController],
  providers: [NcnpReportService],
})
export class NcnpReportModule {}
