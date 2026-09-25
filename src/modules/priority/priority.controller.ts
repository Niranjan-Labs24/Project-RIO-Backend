import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { Controller, Get, Param, Patch, Post, Query, Body, UseInterceptors, UploadedFile, BadRequestException } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { RequirePermission } from "../../common/guards/permission.guard";
import { TypeBoxValidationPipe } from "../../contract/validation.pipe";
import {
  CreateMethodologyVersionBody, type CreateMethodologyVersionDto,
  OverridePriorityScoreBody, type OverridePriorityScoreDto,
} from "./priority.contract";
import { parsePaging } from "../../common/http/query.util";
import { PriorityService } from "./priority.service";
import { ScoreRollupService } from "./rollup.service";
import { PriorityV2Service } from "./priority-v2.service";
import { CenterAggregationService } from "./center-aggregation.service";
import type { CenterComparisonEntry, KpiSeverityEntry, PriorityDashboardPage, PriorityScore } from "./priority.types";

// The real scoring-lookup CSV is ~50 KB; 10 MB leaves ample headroom while bounding memory.
const MAX_LOOKUP_FILE_SIZE_BYTES = 10 * 1024 * 1024;

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
    // Pass the pipeline's outcome straight through: a run can complete as a
    // successful HTTP call and still compute nothing (no responses yet,
    // methodology reference data missing). The frontend renders `reason` as
    // a specific message; returning a bare `{ success: true }` here left it
    // with nothing to say but "produced no priority score".
    return this.rollupService.recalculateStudyScores(studyId, surveyId);
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
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_LOOKUP_FILE_SIZE_BYTES } }))
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
    private readonly centerAggregation: CenterAggregationService,
  ) {}

  // RIO-FR-005 (Q12) — `gapType` filters to Needs whose analyst-entered
  // Gap Type classification matches exactly one of the five fixed values.
  @Get()
  @RequirePermission("priorityScoring", "read")
  list(
    @Query("gapType") gapType?: string,
    @Query("level") level?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ): Promise<PriorityDashboardPage> {
    return this.priorityV2.listPage({ gapType, level }, parsePaging(limit, offset));
  }

  // RIO-FR-005 (Q9) — place comparison. studyIds is a comma-separated
  // query param, e.g. ?studyIds=id-a,id-b,id-c. Grouped by Centre, not by
  // `Need.village`: village is unvalidated free text, Centre is a real key
  // into the client's geographic reference — see CenterAggregationService.
  // The old `village-comparison` path is kept as an alias so an existing
  // bookmark or client build does not 404 on the rename.
  @Get(["center-comparison", "village-comparison"])
  @RequirePermission("priorityScoring", "read")
  compareCenters(@Query("studyIds") studyIds?: string): Promise<CenterComparisonEntry[]> {
    const ids = (studyIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return this.centerAggregation.compareCenters(ids);
  }

  // RIO-FR-005 — heat map side panel drill-down: every KPI scored under one
  // domain × centre cell (see CenterAggregationService.kpiBreakdownForDomain
  // for why gapType/equityFlag are inherited from the owning Need). Lazy,
  // on cell-click — not embedded in compareCenters, which would multiply its
  // payload by every KPI under every domain of every centre.
  @Get("center-comparison/:centerId/domains/:domain/kpis")
  @RequirePermission("priorityScoring", "read")
  kpiBreakdown(
    @Param("centerId") centerId: string,
    @Param("domain") domain: string,
    @Query("studyIds") studyIds?: string,
  ): Promise<KpiSeverityEntry[]> {
    // A place key is a Centre UUID, or a `village:<name>` / `governorate:<uuid>`
    // key (see CenterAggregationService) — a plain UUID pipe rejected the
    // village-keyed entries the comparison now returns, so a heat-map cell click
    // on a village column 400'd.
    if (!/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|governorate:[0-9a-f-]{36}|village:.{1,300})$/i.test(centerId)) {
      throw new BadRequestException({ error: { code: "VALIDATION_ERROR", message: "centerId is not a valid place key" } });
    }
    const ids = (studyIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return this.centerAggregation.kpiBreakdownForDomain(centerId, decodeURIComponent(domain), ids);
  }

  @Patch(":id/approve")
  @RequirePermission("priorityScoring", "approve")
  approve(@Param("id", new UuidParamPipe()) id: string): Promise<PriorityScore> {
    return this.priority.approve(id);
  }
}
