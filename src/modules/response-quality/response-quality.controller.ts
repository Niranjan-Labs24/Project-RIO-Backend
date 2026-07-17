import { Controller, Get, Param, Post, Query } from "@nestjs/common";
import { RequirePermission } from "../../common/guards/permission.guard";
import { ResponseQualityService } from "./response-quality.service";
import type { AiSummary, ResponseQualityResult } from "./response-quality.types";

// Mounted under needs/:needId/... — each Need runs its own independent
// survey/response set now (see the Need-lifecycle migration).
//
// `surveyLinkId` (optional, all four routes): the Insights "Survey Scope"
// selector's filter — omitted/absent means Consolidated (every Survey Link
// belonging to this Need), present scopes to just that one link. Same
// param name/semantics as PriorityController — no separate per-scope
// endpoints, per the plan's "do not create separate endpoints".
@Controller("needs/:needId")
export class ResponseQualityController {
  constructor(private readonly responseQuality: ResponseQualityService) {}

  @Post("response-quality/assess")
  @RequirePermission("aiReview", "write")
  assess(
    @Param("needId") needId: string,
    @Query("surveyLinkId") surveyLinkId?: string,
  ): Promise<ResponseQualityResult[]> {
    return this.responseQuality.assess(needId, surveyLinkId);
  }

  @Get("response-quality")
  @RequirePermission("aiReview", "read")
  list(
    @Param("needId") needId: string,
    @Query("surveyLinkId") surveyLinkId?: string,
  ): Promise<ResponseQualityResult[]> {
    return this.responseQuality.listForNeed(needId, surveyLinkId);
  }

  @Post("ai-summary/generate")
  @RequirePermission("aiReview", "write")
  generateSummary(
    @Param("needId") needId: string,
    @Query("surveyLinkId") surveyLinkId?: string,
  ): Promise<AiSummary> {
    return this.responseQuality.generateSummary(needId, surveyLinkId);
  }

  @Get("ai-summary")
  @RequirePermission("aiReview", "read")
  async getSummary(
    @Param("needId") needId: string,
    @Query("surveyLinkId") surveyLinkId?: string,
  ): Promise<AiSummary | null> {
    return this.responseQuality.getLatestSummary(needId, surveyLinkId);
  }
}
