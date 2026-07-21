import { Controller, Get, Param, Patch, Post, Query, Body, UseInterceptors, UploadedFile, BadRequestException } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { RequirePermission } from "../../common/guards/permission.guard";
import { PriorityService } from "./priority.service";
import { ScoreRollupService } from "./rollup.service";
import { PriorityV2Service } from "./priority-v2.service";
import type { PriorityDashboardEntry, PriorityScore } from "./priority.types";

@Controller()
export class PriorityController {
  constructor(
    private readonly priority: PriorityService,
    private readonly rollupService: ScoreRollupService,
    private readonly priorityV2: PriorityV2Service,
  ) {}

  @Post("needs/:needId/priority-score")
  @RequirePermission("priorityScoring", "create")
  score(@Param("needId") needId: string, @Query("surveyLinkId") surveyLinkId?: string): Promise<PriorityScore> {
    return this.priority.score(needId, surveyLinkId);
  }

  @Get("needs/:needId/priority-score")
  @RequirePermission("priorityScoring", "read")
  getLatest(@Param("needId") needId: string, @Query("surveyLinkId") surveyLinkId?: string): Promise<PriorityScore | null> {
    return this.priority.getLatest(needId, surveyLinkId);
  }

  @Get("studies/:studyId/surveys/:surveyId/severity-dashboard")
  @RequirePermission("priorityScoring", "read")
  async getSeverityDashboard(
    @Param("studyId") studyId: string,
    @Param("surveyId") surveyId: string,
    @Query("villageId") villageId?: string
  ) {
    return this.priority.getDashboard(studyId, surveyId, villageId || null);
  }

  @Get("studies/:studyId/surveys/:surveyId/severity-kpis")
  @RequirePermission("priorityScoring", "read")
  async getSeverityKpis(
    @Param("studyId") studyId: string,
    @Param("surveyId") surveyId: string,
    @Query("villageId") villageId?: string
  ) {
    return this.priority.getKpiRanking(studyId, surveyId, villageId || null);
  }

  @Get("studies/:studyId/surveys/:surveyId/questions/:questionId")
  @RequirePermission("priorityScoring", "read")
  async getQuestionDetail(
    @Param("studyId") studyId: string,
    @Param("surveyId") surveyId: string,
    @Param("questionId") questionId: string,
    @Query("villageId") villageId?: string
  ) {
    return this.priority.getQuestionDetail(studyId, surveyId, questionId, villageId || null);
  }

  @Post("studies/:studyId/surveys/:surveyId/recalculate")
  @RequirePermission("priorityScoring", "create")
  async recalculate(
    @Param("studyId") studyId: string,
    @Param("surveyId") surveyId: string
  ) {
    await this.rollupService.recalculateStudyScores(studyId, surveyId);
    return { success: true };
  }

  @Get("studies/:studyId/surveys/:surveyId/village-priority")
  @RequirePermission("priorityScoring", "read")
  async getVillagePriority(
    @Param("studyId") studyId: string,
    @Param("surveyId") surveyId: string,
    @Query("villageId") villageId?: string
  ) {
    return this.priorityV2.getVillagePriority(studyId, surveyId, villageId || null);
  }

  @Get("methodology-versions")
  @RequirePermission("methodologyQuestionBank", "read")
  async getMethodologyVersions() {
    return this.priority.listMethodologyVersions();
  }

  @Post("methodology-versions")
  @RequirePermission("methodologyQuestionBank", "create")
  async createMethodologyVersion(@Body() body: { name: string; version: string; description?: string }) {
    return this.priority.createMethodologyVersion(body);
  }

  @Post("methodology-versions/:id/upload-lookups")
  @RequirePermission("methodologyQuestionBank", "create")
  @UseInterceptors(FileInterceptor("file"))
  async uploadLookups(
    @Param("id") versionId: string,
    @UploadedFile() file: Express.Multer.File
  ) {
    if (!file) {
      throw new BadRequestException("CSV file is required");
    }
    const csvContent = file.buffer.toString("utf-8");
    return this.priority.uploadLookups(versionId, csvContent);
  }
}

@Controller("priority-scores")
export class PriorityDashboardController {
  constructor(private readonly priority: PriorityService) {}

  @Get()
  @RequirePermission("priorityScoring", "read")
  list(): Promise<PriorityDashboardEntry[]> {
    return this.priority.listForOrg();
  }

  @Patch(":id/approve")
  @RequirePermission("priorityScoring", "approve")
  approve(@Param("id") id: string): Promise<PriorityScore> {
    return this.priority.approve(id);
  }
}
