import { Module } from "@nestjs/common";
import { EvidenceController, EvidenceDeleteController } from "./evidence.controller";
import { EvidenceService } from "./evidence.service";
import { EvidenceStorageService } from "./evidence.storage.service";
import { EvidenceDocumentsService } from "./evidence-documents.service";
import { DocumentSummaryService } from "./document-summary.service";
import { EvidenceDocumentsController } from "./evidence-documents.controller";

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
  ],
  exports: [EvidenceDocumentsService, DocumentSummaryService, EvidenceStorageService],
})
export class EvidenceModule {}
