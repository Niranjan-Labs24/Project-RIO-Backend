import type { IndividualSurveyReportContent } from "../report-content.types";

/**
 * A report must never contradict itself.
 *
 * These assertions are the self-consistency defects the client found, encoded so
 * they cannot regress: coverage tiles that disagreed with the table beneath them
 * (2 domains reported as 4, 9 KPIs as 18), a null severity presented without a
 * reason, and an executive summary that enumerated only the domains this survey
 * happened to touch.
 *
 * Thrown at generation time, not at the client's desk.
 */
export function assertRpt01SelfConsistent(c: IndividualSurveyReportContent): void {
  const errors: string[] = [];

  // One domain row per scored DOMAIN rollup — the exact figure the coverage
  // tile counts, which once said 4 over a table of 2. The UNMAPPED bucket is
  // excluded: it holds KPI rollups with no methodology question behind them
  // (synthetic or retired KPIs) and is an extra row by design, not a domain.
  const scoredDomainRows = c.needsByDomain.filter((d) => d.domainKey !== "UNMAPPED").length;
  if (c.coverage.domainsScored !== scoredDomainRows) {
    errors.push(
      `coverage.domainsScored ${c.coverage.domainsScored} !== ${scoredDomainRows} domain rows`,
    );
  }

  const measured = c.needRecords.filter((n) => n.severityScore !== null).length;
  if (c.coverage.kpisScored !== measured) {
    errors.push(`coverage.kpisScored ${c.coverage.kpisScored} !== ${measured} measured records`);
  }

  const nested = c.needsByDomain.flatMap((d) =>
    d.subDomains.flatMap((s) => s.indicators.flatMap((i) => i.needs)),
  );
  if (nested.length !== c.needRecords.length) {
    errors.push(
      `hierarchy holds ${nested.length} records but needRecords has ${c.needRecords.length}`,
    );
  }

  for (const n of c.needRecords) {
    if (n.severityScore === null && !n.notMeasuredReason) {
      errors.push(`${n.indicatorId}: null severity with no notMeasuredReason`);
    }
    if (n.sourceType === "survey" && n.supportingText !== null) {
      errors.push(`${n.indicatorId}: survey record carries supportingText`);
    }
    if (!n.sourceRef) errors.push(`${n.indicatorId}: missing sourceRef`);
  }

  // Every methodology domain present, assessed or not — an executive summary
  // listing only the covered domains reads as full coverage.
  if (c.executiveSummary.domainDistribution.length !== c.executiveSummary.domainsInMethodology) {
    errors.push(
      `domainDistribution has ${c.executiveSummary.domainDistribution.length} rows but the methodology defines ${c.executiveSummary.domainsInMethodology} domains`,
    );
  }

  // Section 6 is mandatory even when every sub-field is empty.
  if (c.dataQualityNotes?.present !== true) {
    errors.push("dataQualityNotes section is missing — it is mandatory in every report");
  }

  if (errors.length) {
    throw new Error(`RPT01 self-consistency failed:\n  ${errors.join("\n  ")}`);
  }
}
