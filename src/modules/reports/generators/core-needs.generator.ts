import { BadRequestException } from "@nestjs/common";
import { SCOPE_LEVELS, type ScopeLevel } from "../core-needs/core-needs.types";
import type { GeneratedReport, GeneratorCtx } from "./index";

// RPT18 Core Needs Report. The user picks the scope level, the unit at that
// level and the domains; filters.output = SUMMARY issues the first page alone
// as the one-page Executive Summary (same data, so the two never differ).
export async function coreNeedsGenerator(ctx: GeneratorCtx): Promise<GeneratedReport> {
  if (!ctx.studyId) {
    throw new BadRequestException({ error: { code: "STUDY_ID_REQUIRED", message: "RPT18 requires a studyId." } });
  }
  const level = (typeof ctx.filters.scopeLevel === "string" ? ctx.filters.scopeLevel : "KINGDOM") as ScopeLevel;
  if (!SCOPE_LEVELS.includes(level)) {
    throw new BadRequestException({ error: { code: "SCOPE_LEVEL_INVALID", message: "Unknown scope level." } });
  }
  const unitId = typeof ctx.filters.unitId === "string" ? ctx.filters.unitId.trim() : "";
  if (level !== "KINGDOM" && !unitId) {
    throw new BadRequestException({ error: { code: "SCOPE_UNIT_REQUIRED", message: "Choose the area for this scope level." } });
  }
  const output = ctx.filters.output === "SUMMARY" ? "SUMMARY" : "FULL";
  const domainKeys = Array.isArray(ctx.filters.domainKeys)
    ? ctx.filters.domainKeys.filter((d): d is string => typeof d === "string" && d.length > 0)
    : [];

  const filters = { ...ctx.filters, scopeLevel: level, unitId: unitId || null, output, domainKeys };
  const content = await ctx.provider.getCoreNeedsReport({
    studyId: ctx.studyId,
    studyTitle: ctx.studyTitle,
    orgId: ctx.orgId,
    filters,
  });
  const area = content.header.unitName ?? content.header.studyName;
  return {
    title: `${output === "SUMMARY" ? "Executive Summary" : "Core Needs Report"} — ${area}`,
    content: { ...content },
  };
}
