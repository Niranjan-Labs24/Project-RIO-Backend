import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { UuidParamPipe } from "../../common/pipes/uuid-param.pipe";
import { RequirePermission } from "../../common/guards/permission.guard";
import {
  CombinedReportSummaryService,
  CombinedReportOutputJson,
} from "./combined-report-summary.service";

@Controller("studies/:studyId/combined-report")
export class CombinedReportSummaryController {
  constructor(private readonly service: CombinedReportSummaryService) {}

  @Get()
  @RequirePermission("reportsDashboards", "read")
  async getContext(@Param("studyId", new UuidParamPipe()) studyId: string) {
    return this.service.getCombinedReportContext(studyId);
  }

  @Post("generate")
  @RequirePermission("aiReview", "write")
  async generateSummary(
    @Param("studyId", new UuidParamPipe()) studyId: string,
    @Body("documentSummaryIds") documentSummaryIds: string[],
    @Body("scoreSummaryId") scoreSummaryId?: string,
  ) {
    return this.service.generateCombinedSummary(studyId, documentSummaryIds, scoreSummaryId);
  }

  @Put("summary/:summaryId")
  @RequirePermission("aiReview", "write")
  async updateSummary(
    @Param("summaryId", new UuidParamPipe()) summaryId: string,
    @Body() body: CombinedReportOutputJson,
  ) {
    return this.service.updateDraftCombinedSummary(summaryId, body);
  }

  @Post("summary/:summaryId/confirm")
  @RequirePermission("aiReview", "write")
  async confirmSummary(@Param("summaryId", new UuidParamPipe()) summaryId: string) {
    return this.service.confirmCombinedSummary(summaryId);
  }
}
