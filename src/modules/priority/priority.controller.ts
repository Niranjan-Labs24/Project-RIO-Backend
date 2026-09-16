import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { Controller, Get, Param, Patch, Post, Query, Body, UseInterceptors, UploadedFile, BadRequestException } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { RequirePermission } from "../../common/guards/permission.guard";
import { TypeBoxValidationPipe } from "../../contract/validation.pipe";
import {
  CreateMethodologyVersionBody, type CreateMethodologyVersionDto,
  OverridePriorityScoreBody, type OverridePriorityScoreDto,
} from "./priority.contract";
import { PriorityService } from "./priority.service";
import { ScoreRollupService } from "./rollup.service";
import { PriorityV2Service } from "./priority-v2.service";
import { VillageAggregationService } from "./village-aggregation.service";
import type { PriorityDashboardEntry, PriorityScore, VillageComparisonEntry } from "./priority.types";

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

  /**
   * RIO-FR-003 AC 5. Gated on `priorityScoring:approve`, not `write`: an
   * override is a reviewer decision about the number, the same class of act as
   * approving it. Whoever can only run the scoring engine should not be able
   * to overrule what it produced.
   */
  @Patch("priority-scores/:id/override")
  @RequirePermission("priorityScoring", "approve")
  override(
    @Param("id", new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(OverridePriorityScoreBody)) body: OverridePriorityScoreDto,
  ): Promise<PriorityScore> {
    return this.priority.override(id, body.overrideScore, body.reason);
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

  // Gated on studySurvey:read, not methodologyQuestionBank:read — this list
  // only feeds the Study create/edit form's mandatory Methodology Version
  // picklist. NGO Admin (and every other role that can view/create a
  // Study) has no methodologyQuestionBank access by design, which left the
  // picklist permanently empty and Study creation permanently blocked for
  // them. methodologyQuestionBank:read stays the gate for anything that
  // manages methodology content itself (create/edit versions).
  @Get("methodology-versions")
  @RequirePermission("studySurvey", "read")
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
    private readonly villageAggregation: VillageAggregationService,
  ) {}

  // RIO-FR-005 (Q12) — `gapType` filters to Needs whose analyst-entered
  // Gap Type classification matches exactly one of the five fixed values.
  @Get()
  @RequirePermission("priorityScoring", "read")
  list(@Query("gapType") gapType?: string): Promise<PriorityDashboardEntry[]> {
    return this.priorityV2.listForOrg(gapType);
  }

  // RIO-FR-005 (Q9) — village comparison. studyIds is a comma-separated
  // query param, e.g. ?studyIds=id-a,id-b,id-c.
  @Get("village-comparison")
  @RequirePermission("priorityScoring", "read")
  compareVillages(@Query("studyIds") studyIds?: string): Promise<VillageComparisonEntry[]> {
    const ids = (studyIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return this.villageAggregation.compareVillages(ids);
  }

  @Patch(":id/approve")
  @RequirePermission("priorityScoring", "approve")
  approve(@Param("id", new UuidParamPipe()) id: string): Promise<PriorityScore> {
    return this.priority.approve(id);
  }
}
