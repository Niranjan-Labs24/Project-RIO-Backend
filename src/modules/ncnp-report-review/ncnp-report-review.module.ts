import { Module } from '@nestjs/common';
import { NcnpReportModule } from '../ncnp-report/ncnp-report.module';
import { TranslationModule } from '../translation/translation.module';
import { NcnpReportReviewController } from './ncnp-report-review.controller';
import { NcnpReportReviewService } from './ncnp-report-review.service';

@Module({
  imports: [NcnpReportModule, TranslationModule],
  controllers: [NcnpReportReviewController],
  providers: [NcnpReportReviewService],
})
export class NcnpReportReviewModule {}
