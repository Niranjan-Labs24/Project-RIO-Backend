import { Module } from '@nestjs/common';
import { NcnpReportController } from './ncnp-report.controller';
import { NcnpReportService } from './ncnp-report.service';

@Module({
  controllers: [NcnpReportController],
  providers: [NcnpReportService],
  // NcnpReportReviewService reuses getReport() as-is to snapshot a review
  // row — no changes to this service itself, just exported for that one
  // caller.
  exports: [NcnpReportService],
})
export class NcnpReportModule {}
