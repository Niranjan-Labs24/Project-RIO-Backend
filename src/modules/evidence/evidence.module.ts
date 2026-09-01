import { Module } from "@nestjs/common";
import { EvidenceController, EvidenceDeleteController } from "./evidence.controller";
import { EvidenceService } from "./evidence.service";
import { EvidenceStorageService } from "./evidence.storage.service";
import { EvidenceDocumentsService } from "./evidence-documents.service";
import { DocumentSummaryService } from "./document-summary.service";
import { EvidenceDocumentsController } from "./evidence-documents.controller";
import { EvidenceFileCleanupService } from "./evidence-file-cleanup.service";

@Module({
  controllers: [
    EvidenceController,
    EvidenceDeleteController,
    EvidenceDocumentsController,
  ],
  providers: [
    EvidenceService,
    EvidenceStorageService,
    EvidenceDocumentsService,
    DocumentSummaryService,
    // GAP-13 — relies on ScheduleModule.forRoot() being imported once,
    // globally, in AppModule (see app.module.ts), same as
    // CitizenPiiRetentionService/SystemLogsRetentionService/BackupService.
    EvidenceFileCleanupService,
  ],
  exports: [EvidenceDocumentsService, DocumentSummaryService],
})
export class EvidenceModule {}
