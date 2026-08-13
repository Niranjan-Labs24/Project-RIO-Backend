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

  // Client-confirmed (Aug 14): Combined Summary Report generation is
  // exclusively Data Analyst's — was aiReview:write, shared with Research
  // Officer's unrelated Need-classification-trigger use of that flag.
  // priorityScoring:create/write is the precise gate: Data Analyst holds
  // both, Research Officer holds neither. Pragmatic split ahead of formal
  // client sign-off on the exact module.
  @Post("generate")
  @RequirePermission("priorityScoring", "create")
  async generateSummary(
    @Param("studyId", new UuidParamPipe()) studyId: string,
    @Body("documentSummaryIds") documentSummaryIds: string[],
    @Body("scoreSummaryId") scoreSummaryId?: string,
  ) {
    return this.service.generateCombinedSummary(studyId, documentSummaryIds, scoreSummaryId);
  }

  @Put("summary/:summaryId")
  @RequirePermission("priorityScoring", "write")
  async updateSummary(
    @Param("summaryId", new UuidParamPipe()) summaryId: string,
    @Body() body: CombinedReportOutputJson,
  ) {
    return this.service.updateDraftCombinedSummary(summaryId, body);
  }

  @Post("summary/:summaryId/confirm")
  @RequirePermission("priorityScoring", "write")
  async confirmSummary(@Param("summaryId", new UuidParamPipe()) summaryId: string) {
    return this.service.confirmCombinedSummary(summaryId);
  }
}
