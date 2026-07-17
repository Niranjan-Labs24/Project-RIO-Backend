import { Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { RequirePermission } from "../../common/guards/permission.guard";
import { PriorityService } from "./priority.service";
import type { PriorityDashboardEntry, PriorityScore } from "./priority.types";

// `surveyLinkId` (optional): the Insights "Survey Scope" selector's filter —
// omitted means Consolidated (every Survey Link belonging to this Need),
// present scopes to just that one link. Same param name/semantics as
// ResponseQualityController — no separate per-scope endpoints.
@Controller("needs/:needId/priority-score")
export class PriorityController {
  constructor(private readonly priority: PriorityService) {}

  @Post()
  @RequirePermission("priorityScoring", "create")
  score(@Param("needId") needId: string, @Query("surveyLinkId") surveyLinkId?: string): Promise<PriorityScore> {
    return this.priority.score(needId, surveyLinkId);
  }

  @Get()
  @RequirePermission("priorityScoring", "read")
  getLatest(@Param("needId") needId: string, @Query("surveyLinkId") surveyLinkId?: string): Promise<PriorityScore | null> {
    return this.priority.getLatest(needId, surveyLinkId);
  }
}

@Controller("priority-scores")
export class PriorityDashboardController {
  constructor(private readonly priority: PriorityService) {}

  // Org-wide ranked dashboard — every Need, its latest *approved* score if
  // scored and approved (see PriorityService.listForOrg).
  @Get()
  @RequirePermission("priorityScoring", "read")
  list(): Promise<PriorityDashboardEntry[]> {
    return this.priority.listForOrg();
  }

  // Human Review gate — a Priority Score never becomes publicly visible
  // (this dashboard, Reports) until a reviewer approves it here.
  @Patch(":id/approve")
  @RequirePermission("priorityScoring", "approve")
  approve(@Param("id") id: string): Promise<PriorityScore> {
    return this.priority.approve(id);
  }
}
