import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { Controller, Get, Param, Patch, Post, Query, Body, UseInterceptors, UploadedFile, BadRequestException } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { RequirePermission } from "../../common/guards/permission.guard";
import { TypeBoxValidationPipe } from "../../contract/validation.pipe";
import { CreateMethodologyVersionBody, type CreateMethodologyVersionDto } from "./priority.contract";
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
  score(@Param("needId", new UuidParamPipe()) needId: string, @Query("surveyLinkId") surveyLinkId?: string): Promise<PriorityScore> {
    return this.priority.score(needId, surveyLinkId);
  }

  @Get("needs/:needId/priority-score")
  @RequirePermission("priorityScoring", "read")
  getLatest(@Param("needId", new UuidParamPipe()) needId: string, @Query("surveyLinkId") surveyLinkId?: string): Promise<PriorityScore | null> {
    return this.priority.getLatest(needId, surveyLinkId);
  }

  @Get("studies/:studyId/surveys/:surveyId/severity-dashboard")
  @RequirePermission("priorityScoring", "read")
  async getSeverityDashboard(
    @Param("studyId", new UuidParamPipe()) studyId: string,
    @Param("surveyId", new UuidParamPipe()) surveyId: string,
    @Query("villageId") villageId?: string
  ) {
    return this.priority.getDashboard(studyId, surveyId, villageId || null);
  }

  @Get("studies/:studyId/surveys/:surveyId/severity-kpis")
  @RequirePermission("priorityScoring", "read")
  async getSeverityKpis(
    @Param("studyId", new UuidParamPipe()) studyId: string,
    @Param("surveyId", new UuidParamPipe()) surveyId: string,
    @Query("villageId") villageId?: string
  ) {
    return this.priority.getKpiRanking(studyId, surveyId, villageId || null);
  }

  @Get("studies/:studyId/surveys/:surveyId/questions/:questionId")
  @RequirePermission("priorityScoring", "read")
  async getQuestionDetail(
    @Param("studyId", new UuidParamPipe()) studyId: string,
    @Param("surveyId", new UuidParamPipe()) surveyId: string,
    @Param("questionId", new UuidParamPipe()) questionId: string,
    @Query("villageId") villageId?: string
  ) {
    return this.priority.getQuestionDetail(studyId, surveyId, questionId, villageId || null);
  }

  @Post("studies/:studyId/surveys/:surveyId/recalculate")
  @RequirePermission("priorityScoring", "create")
  async recalculate(
    @Param("studyId", new UuidParamPipe()) studyId: string,
    @Param("surveyId", new UuidParamPipe()) surveyId: string
  ) {
    await this.rollupService.recalculateStudyScores(studyId, surveyId);
    return { success: true };
  }

  @Get("studies/:studyId/surveys/:surveyId/village-priority")
  @RequirePermission("priorityScoring", "read")
  async getVillagePriority(
    @Param("studyId", new UuidParamPipe()) studyId: string,
    @Param("surveyId", new UuidParamPipe()) surveyId: string,
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
  async createMethodologyVersion(
    @Body(new TypeBoxValidationPipe(CreateMethodologyVersionBody)) body: CreateMethodologyVersionDto,
  ) {
    return this.priority.createMethodologyVersion(body);
  }

  @Post("methodology-versions/:id/upload-lookups")
  @RequirePermission("methodologyQuestionBank", "create")
  @UseInterceptors(FileInterceptor("file"))
  async uploadLookups(
    @Param("id", new UuidParamPipe()) versionId: string,
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
  constructor(
    private readonly priority: PriorityService,
    private readonly priorityV2: PriorityV2Service,
  ) {}

  @Get()
  @RequirePermission("priorityScoring", "read")
  list(): Promise<PriorityDashboardEntry[]> {
    return this.priorityV2.listForOrg();
  }

  @Patch(":id/approve")
  @RequirePermission("priorityScoring", "approve")
  approve(@Param("id", new UuidParamPipe()) id: string): Promise<PriorityScore> {
    return this.priority.approve(id);
  }
}
