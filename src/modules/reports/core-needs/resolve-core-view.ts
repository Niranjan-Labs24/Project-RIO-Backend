// Builds a Core Needs view in one language — shared by RPT18 (ReportsService)
// and the NCNP needs report (NcnpReportReviewService), so the two read alike.

import { ConflictException } from "@nestjs/common";
import type { MasterDataAliases } from "../i18n/master-data-names";
import type { SupportedLocale } from "../../translation/translation.types";
import { isCurrentCoreNeedsContent, type CoreNeedsContent } from "./core-needs.types";
import { buildCoreView, type CoreAudit, type CoreView } from "./core-needs-view";

export type TranslateMany = (
  texts: readonly string[],
  locale: SupportedLocale,
) => Promise<Array<{ translatedText: string; unchanged?: boolean }>>;

/** Free text (village names, study titles, target group) in `locale`, through
 *  the translation cache; the master-data names come from `aliases`. */
export async function resolveCoreView(input: {
  content: CoreNeedsContent;
  locale: SupportedLocale;
  aliases: MasterDataAliases;
  translateMany: TranslateMany;
  audit: CoreAudit;
}): Promise<CoreView> {
  // Stored before the 15 Oct 2026 rules (three bands): regenerate instead.
  if (!isCurrentCoreNeedsContent(input.content)) {
    throw new ConflictException({
      error: { code: "REPORT_OUTDATED", message: "This report was generated with earlier report rules. Generate it again." },
    });
  }
  const { content, locale, aliases } = input;
  const texts = new Set<string>();
  const add = (s: string | null | undefined) => {
    if (!s || aliases.has(s.trim().toLowerCase())) return;
    texts.add(s);
    // "Village — Governorate": the village part is translated on its own; the
    // governorate takes its master-data name (core-needs-view name()).
    const parts = / — (.+)$/.exec(s);
    if (parts && aliases.has(parts[1]!.trim().toLowerCase())) texts.add(s.slice(0, parts.index));
  };
  add(content.header.studyName);
  add(content.header.unitName);
  // Typed elsewhere in the platform and printed in the report: the owning
  // organisation, the survey's selection method, the area profile's source,
  // the methodology version's name and the reviewer's comments.
  add(content.header.organizationName);
  add(content.header.selectionApproach);
  add(content.header.methodologyVersion);
  add(content.profile.figures?.source);
  add(input.audit.reviewerNotes);
  add(content.targetGroup);
  content.summary.villagesWithData.forEach(add);
  content.villages.forEach((v) => add(v.name));
  content.evidence.distribution.forEach((d) => add(d.unit));
  content.rankedNeeds.forEach((n) => n.where.forEach(add));
  content.needCards.forEach((c) => c.location.forEach(add));
  for (const a of content.evidence.collectNext) if ("where" in a) add(a.where);
  content.studies?.forEach((s) => add(s.title));

  const freeText = new Map<string, string>();
  try {
    const list = [...texts];
    const results = await input.translateMany(list, locale);
    list.forEach((t, i) => {
      const r = results[i];
      if (r && !r.unchanged) freeText.set(t, r.translatedText);
    });
  } catch {
    // Free text stays as typed when translation is unavailable.
  }
  return buildCoreView({ content, locale, aliases, freeText, audit: input.audit });
}
