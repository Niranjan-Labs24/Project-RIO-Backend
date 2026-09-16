import { Module } from "@nestjs/common";
import { HistoricalStudiesModule } from "../historical-studies/historical-studies.module";
import { ArchiveController } from "./archive.controller";
import { ArchiveService } from "./archive.service";

@Module({
  imports: [HistoricalStudiesModule],
  controllers: [ArchiveController],
  providers: [ArchiveService],
})
export class ArchiveModule {}
