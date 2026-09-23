import { Module } from "@nestjs/common";
import { EvidenceModule } from "../evidence/evidence.module";
import { HistoricalStudiesModule } from "../historical-studies/historical-studies.module";
import { ArchiveController } from "./archive.controller";
import { ArchiveService } from "./archive.service";
import { PublicArchiveController } from "./public-archive.controller";
import { PublicArchiveService } from "./public-archive.service";
import { PublicDocumentReaderService } from "./public-document-reader.service";

@Module({
  // EvidenceModule for EvidenceStorageService — the public document
  // reader borrows its path-checked read, and nothing else from it.
  imports: [HistoricalStudiesModule, EvidenceModule],
  // The public controller is registered alongside the authenticated one but
  // shares nothing with it — its own service, its own response type, one GET.
  controllers: [ArchiveController, PublicArchiveController],
  providers: [ArchiveService, PublicArchiveService, PublicDocumentReaderService],
})
export class ArchiveModule {}
