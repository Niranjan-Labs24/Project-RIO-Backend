import { Controller, Get, Param, Post, Query } from "@nestjs/common";
import { RequirePermission } from "../../common/guards/permission.guard";
import { PriorityService } from "./priority.service";
import type { PriorityDashboardEntry, PriorityScore } from "./priority.types";

// `surveyLinkId` (optional): the Study Insights "Survey Scope" selector's
// filter — omitted means Consolidated (every Survey Link belonging to the
// Study), present scopes to just that one link. Same param name/semantics
// as ResponseQualityController — no separate per-scope endpoints.
@Controller("studies/:studyId/priority-score")
export class PriorityController {
  constructor(private readonly priority: PriorityService) {}

  @Post()
  @RequirePermission("priorityScoring", "create")
  score(@Param("studyId") studyId: string, @Query("surveyLinkId") surveyLinkId?: string): Promise<PriorityScore> {
    return this.priority.score(studyId, surveyLinkId);
  }

  @Get()
  @RequirePermission("priorityScoring", "read")
  getLatest(@Param("studyId") studyId: string, @Query("surveyLinkId") surveyLinkId?: string): Promise<PriorityScore | null> {
    return this.priority.getLatest(studyId, surveyLinkId);
  }
}

// Org-wide ranked dashboard — every study, its latest score if scored.
@Controller("priority-scores")
export class PriorityDashboardController {
  constructor(private readonly priority: PriorityService) {}

  @Get()
  @RequirePermission("priorityScoring", "read")
  list(): Promise<PriorityDashboardEntry[]> {
    return this.priority.listForOrg();
  }
}
