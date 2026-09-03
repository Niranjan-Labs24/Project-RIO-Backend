import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { TenancyModule } from "../../tenancy/tenancy.module";
import { AuditModule } from "../audit/audit.module";
import { CleaningContextService } from "./cleaning-context.service";
import { DataCleaningController } from "./data-cleaning.controller";
import { DataCleaningService } from "./data-cleaning.service";
import { DuplicateDetectionService } from "./duplicate-detection.service";
import { DuplicateReviewService } from "./duplicate-review.service";
import { FlagReviewService } from "./flag-review.service";
import { NeedMergeService } from "./need-merge.service";

/**
 * RIO-FR-002. Two halves, deliberately in separate classes:
 *
 *   DataCleaningService — PRODUCES flags. Exported for the three source
 *     adapters (NeedsService, NeedsImportService, CitizenService) to call
 *     fire-and-forget. Never touches a record.
 *   FlagReviewService — serves the reviewer queue and applies a decision. The
 *     only place in FR-002 that writes to a Need or a SurveyResponse, and only
 *     on an explicit human decision (Q11).
 *
 *   DuplicateDetectionService — the LITERAL duplicate pass (Q40's first
 *     half). Proposes pairs; never merges.
 *   DuplicateReviewService — the shared duplicate queue and its decisions.
 *
 * RIO-AI-004 adds the semantic pass over the same table and the merge action.
 */
@Module({
  imports: [PrismaModule, TenancyModule, AuditModule],
  controllers: [DataCleaningController],
  providers: [
    DataCleaningService,
    CleaningContextService,
    FlagReviewService,
    DuplicateDetectionService,
    DuplicateReviewService,
    NeedMergeService,
  ],
  exports: [DataCleaningService, CleaningContextService, DuplicateDetectionService],
})
export class DataCleaningModule {}
