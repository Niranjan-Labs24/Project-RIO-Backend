import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { ConfigService } from '../../config/config.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { TenancyModule } from '../../tenancy/tenancy.module';
import { AuditModule } from '../audit/audit.module';
import { PriorityModule } from '../priority/priority.module';
import { CleaningContextService } from './cleaning-context.service';
import { CleaningSettingsService } from './cleaning-settings.service';
import { DataCleaningController } from './data-cleaning.controller';
import { DataCleaningService } from './data-cleaning.service';
import { DuplicateDetectionService } from './duplicate-detection.service';
import { DuplicateReviewService } from './duplicate-review.service';
import { FlagReviewService } from './flag-review.service';
import { EMBEDDING_PROVIDER } from './embedding-provider.token';
import { GeminiEmbeddingProvider } from './gemini-embedding-provider';
import { OciCohereEmbeddingProvider } from './oci-cohere-embedding-provider';
import { NeedMergeService } from './need-merge.service';
import { SemanticDuplicateService } from './semantic-duplicate.service';

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
  // PriorityModule for DeterministicScoringService — accepting a corrected
  // numeric answer re-scores the response it belongs to.
  imports: [PrismaModule, TenancyModule, AuditModule, PriorityModule, ConfigModule],
  controllers: [DataCleaningController],
  providers: [
    DataCleaningService,
    CleaningContextService,
    FlagReviewService,
    DuplicateDetectionService,
    DuplicateReviewService,
    NeedMergeService,
    CleaningSettingsService,
    SemanticDuplicateService,
    // RIO-AI-004 — the swap point, and where Q10's answer lands.
    //
    // Q10 named OCI Cohere, so embedding follows AI_PROVIDER rather than
    // being pinned to one vendor. That the two settings move together is the
    // point: a deployment that keeps chat in-Kingdom and quietly embedded
    // citizen-entered text somewhere else would satisfy the letter of the
    // ruling and break it in substance. One setting, both paths.
    //
    // Each provider decides for itself whether it is enabled (credentials
    // present AND SEMANTIC_DUPLICATES_ENABLED set), so a disabled deployment
    // still gets a real object rather than a null branch scattered through
    // the callers — and the queue shows "switched off for this deployment"
    // rather than an error.
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: (config: ConfigService) =>
        config.aiProvider === 'gemini'
          ? new GeminiEmbeddingProvider(config)
          : new OciCohereEmbeddingProvider(config),
      inject: [ConfigService],
    },
  ],
  exports: [
    DataCleaningService,
    CleaningContextService,
    DuplicateDetectionService,
    SemanticDuplicateService,
  ],
})
export class DataCleaningModule {}
