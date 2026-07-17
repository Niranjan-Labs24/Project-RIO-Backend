import { Controller, Get, Param, Post, Query } from "@nestjs/common";
import { RequirePermission } from "../../common/guards/permission.guard";
import { ResponseQualityService } from "./response-quality.service";
import type { AiSummary, ResponseQualityResult } from "./response-quality.types";

// Mounted under studies/:studyId/... as its own controller, same precedent
// as AiDecisionsController/PublicSurveysController — Studies stays a
// Dev2-owned module this session doesn't touch directly.
//
// `surveyLinkId` (optional, all four routes): the Study Insights "Survey
// Scope" selector's filter — omitted/absent means Consolidated (every
// Survey Link belonging to the Study), present scopes to just that one
// link. Same param name/semantics as PriorityController — no separate
// per-scope endpoints, per the plan's "do not create separate endpoints".
@Controller("studies/:studyId")
export class ResponseQualityController {
  constructor(private readonly responseQuality: ResponseQualityService) {}

  @Post("response-quality/assess")
  @RequirePermission("aiReview", "write")
  assess(
    @Param("studyId") studyId: string,
    @Query("surveyLinkId") surveyLinkId?: string,
  ): Promise<ResponseQualityResult[]> {
    return this.responseQuality.assess(studyId, surveyLinkId);
  }

  @Get("response-quality")
  @RequirePermission("aiReview", "read")
  list(
    @Param("studyId") studyId: string,
    @Query("surveyLinkId") surveyLinkId?: string,
  ): Promise<ResponseQualityResult[]> {
    return this.responseQuality.listForStudy(studyId, surveyLinkId);
  }

  @Post("ai-summary/generate")
  @RequirePermission("aiReview", "write")
  generateSummary(
    @Param("studyId") studyId: string,
    @Query("surveyLinkId") surveyLinkId?: string,
  ): Promise<AiSummary> {
    return this.responseQuality.generateSummary(studyId, surveyLinkId);
  }

  @Get("ai-summary")
  @RequirePermission("aiReview", "read")
  async getSummary(
    @Param("studyId") studyId: string,
    @Query("surveyLinkId") surveyLinkId?: string,
  ): Promise<AiSummary | null> {
    return this.responseQuality.getLatestSummary(studyId, surveyLinkId);
  }
}
