import { flattenReportContent } from "./report-content-flatten";

// Normalized, render-agnostic report document. The PDF and Excel renderers
// both consume this, so layout logic lives in one place and the two exports
// stay in sync. buildReportDoc maps each report's `content` (see the
// generators) into these sections; unknown/placeholder shapes fall back to the
// generic flatten path.

export type DocSection =
  | { kind: "keyvalue"; heading: string; rows: Array<{ label: string; value: string }> }
  | { kind: "table"; heading: string; columns: string[]; rows: string[][] }
  | { kind: "bars"; heading: string; max: number; bars: Array<{ label: string; value: number }> }
  | { kind: "pie"; heading: string; slices: Array<{ label: string; value: number }> }
  | { kind: "gauge"; heading: string; value: number; max: number; sub?: string }
  | { kind: "radar"; heading: string; max: number; axes: string[]; series: Array<{ name: string; values: number[] }> }
  | { kind: "list"; heading: string; items: string[] }
  | { kind: "note"; heading: string; text: string }
  // A strip of headline counts (studies / needs / responses / …). Used for the
  // coverage and portfolio bands, where the point is the magnitude of each
  // figure rather than any relationship between them — a bar chart of unrelated
  // counts on different scales would mislead.
  | { kind: "stats"; heading: string; tiles: Array<{ label: string; value: string; sub?: string }> }
  // Paired bars for the same categories across two series (e.g. this survey vs
  // the organisation average), so the gap is the visual, not the numbers.
  | {
      kind: "groupedBars";
      heading: string;
      max: number;
      groups: string[];
      series: Array<{ name: string; values: number[] }>;
    }
  // Renders its children side by side (used to keep the report to 1–2 pages).
  | { kind: "columns"; children: DocSection[] };

export interface ReportDoc {
  title: string;
  headerBand: Array<{ label: string; value: string }>;
  sections: DocSection[];
  audit: Array<{ label: string; value: string }>;
}

function titleCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

// Any field whose key looks like a 0-100 score/index — these round to a
// whole number everywhere in the app (dashboards, gauges, ...), so a report
// showing "58.4135" or "76.28999999999999" for the exact same figure reads
// as a bug, not precision.
const WHOLE_NUMBER_KEY = /score|index/i;

function scalar(value: unknown, key?: string): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (key && WHOLE_NUMBER_KEY.test(key)) return String(Math.round(value));
    // Floating-point rollups (e.g. 76.28999999999999) are real math, not a
    // display value — cap to 2 decimals so every other number stays legible
    // without losing meaningful precision (weights, rates, ...).
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  }
  // Fold ISO datetimes to a compact, human-readable stamp (e.g. 22 Jul 2026,
  // 10:30) so reports never show raw "2026-07-22T10:30:00.000Z".
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    }
  }
  return String(value);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isObjectArray(v: unknown): v is Array<Record<string, unknown>> {
  return Array.isArray(v) && v.length > 0 && isPlainObject(v[0]);
}

function kvRows(obj: Record<string, unknown>): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!isPlainObject(v) && !Array.isArray(v)) rows.push({ label: titleCase(k), value: scalar(v, k) });
  }
  return rows;
}

// Response Quality rows, but the qualitative confidence band and its numeric %
// are folded into one row ("Overall Confidence: STANDARD (90%)") so the two read
// together and the raw confidencePct isn't shown as a separate line.
function responseQualityRows(obj: Record<string, unknown>): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === "confidencePct") continue; // folded into the confidence row below
    if (isPlainObject(v) || Array.isArray(v)) continue;
    if (k === "overallConfidence" && typeof obj.confidencePct === "number") {
      rows.push({ label: titleCase(k), value: `${scalar(v, k)} (${obj.confidencePct}%)` });
    } else {
      rows.push({ label: titleCase(k), value: scalar(v, k) });
    }
  }
  return rows;
}

function tableSection(heading: string, arr: Array<Record<string, unknown>>): DocSection {
  const keys = [...new Set(arr.flatMap((o) => Object.keys(o)))];
  return {
    kind: "table",
    heading,
    columns: keys.map(titleCase),
    rows: arr.map((o) => keys.map((k) => scalar(o[k], k))),
  };
}

// Table with an explicit column set + concise labels — keeps wide detail tables
// readable in the fixed-width PDF (long headers like "Performance Score" left
// the short values floating far away and looking misaligned).
interface Col {
  key: string;
  label: string;
  // Optional custom cell renderer — e.g. to combine two fields into one column
  // (Confidence = qualitative band + quantitative %). Falls back to scalar().
  format?: (o: Record<string, unknown>) => string;
}
function pickTableSection(heading: string, arr: Array<Record<string, unknown>>, cols: Col[]): DocSection {
  const present = cols.filter((c) => arr.some((o) => o[c.key] !== undefined));
  return {
    kind: "table",
    heading,
    columns: present.map((c) => c.label),
    rows: arr.map((o) => present.map((c) => (c.format ? c.format(o) : scalar(o[c.key], c.key)))),
  };
}

const DOMAIN_TABLE_COLS: Col[] = [
  { key: "name", label: "Domain" },
  // Methodology domain code — maps the row back to the methodology indicators.
  { key: "domainCode", label: "Code" },
  { key: "severityScore", label: "Severity" },
  { key: "performanceScore", label: "Performance" },
  { key: "weight", label: "Weight" },
  // KPIs contributing to this domain's severity.
  { key: "kpiCount", label: "KPIs" },
  // Confidence shows both the qualitative band and the quantitative % (e.g.
  // "STANDARD (82%)"). confidencePct is folded in here rather than a column.
  {
    key: "confidence",
    label: "Confidence",
    format: (o) =>
      typeof o.confidencePct === "number" ? `${scalar(o.confidence)} (${o.confidencePct}%)` : scalar(o.confidence),
  },
  { key: "isCriticalDomain", label: "Critical" },
];

const TOP_KPI_COLS: Col[] = [
  { key: "rank", label: "#" },
  { key: "kpi", label: "KPI" },
  { key: "domain", label: "Domain" },
  { key: "severityScore", label: "Severity" },
  { key: "confidence", label: "Confidence" },
  { key: "validResponseCount", label: "Responses" },
];

function barsSection(
  heading: string,
  arr: Array<Record<string, unknown>>,
  labelKey: string,
  valueKey: string,
  max: number,
): DocSection {
  return {
    kind: "bars",
    heading,
    max,
    bars: arr
      .filter((o) => typeof o[valueKey] === "number")
      // Bar charts print `value` as raw text next to the track (see
      // renderBars) — round it same as every other score, it bypasses scalar().
      .map((o) => ({ label: scalar(o[labelKey]), value: Math.round(o[valueKey] as number) })),
  };
}

// A radar/profile of the domains' severity (and performance, when present).
// Only meaningful with ≥3 axes.
function domainRadar(domains: Array<Record<string, unknown>>): DocSection {
  const hasPerf = domains.some((d) => typeof d.performanceScore === "number");
  return {
    kind: "radar",
    heading: "Domain Profile",
    max: 100,
    axes: domains.map((d) => scalar(d.name)),
    series: [
      { name: "Severity", values: domains.map((d) => Number(d.severityScore) || 0) },
      ...(hasPerf ? [{ name: "Performance", values: domains.map((d) => Number(d.performanceScore) || 0) }] : []),
    ],
  };
}

function aiSummarySections(ai: Record<string, unknown>): DocSection[] {
  const out: DocSection[] = [];
  const kv: Array<{ label: string; value: string }> = [];
  for (const key of ["executiveSummary", "keyFindings", "dataQualityNote", "trendNote"]) {
    if (ai[key]) kv.push({ label: titleCase(key), value: String(ai[key]) });
  }
  if (kv.length) out.push({ kind: "keyvalue", heading: "AI Summary", rows: kv });
  if (Array.isArray(ai.recommendations) && ai.recommendations.length) {
    out.push({ kind: "list", heading: "Recommendations", items: ai.recommendations.map(String) });
  }
  return out;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Coverage tiles — the "how much data is this built on?" band that opens every
// survey-scoped report. Ordered so the reader gets scope (what was assessed)
// before volume (how much came back) before depth (what was scored).
function coverageStats(c: Record<string, unknown>): DocSection {
  const submitted = n(c.responsesSubmitted);
  const valid = n(c.responsesValid);
  const validPct = submitted > 0 ? Math.round((valid / submitted) * 100) : 0;

  return {
    kind: "stats",
    heading: "Assessment Coverage",
    tiles: [
      { label: "Needs in study", value: String(n(c.needsInStudy)), sub: `${n(c.needsCoveredByThisSurvey)} covered here` },
      { label: "Surveys in study", value: String(n(c.surveysInStudy)) },
      { label: "Villages covered", value: String(n(c.villagesCovered)), sub: `${n(c.governoratesCovered)} governorate(s)` },
      {
        label: "Questions asked",
        value: String(n(c.surveyQuestionsTotal)),
        sub: `${n(c.surveyQuestionsFromBank)} bank / ${n(c.surveyQuestionsCustom)} custom`,
      },
      { label: "Survey links", value: String(n(c.publicSurveyLinks)), sub: `${n(c.activeSurveyLinks)} active` },
      { label: "Responses submitted", value: String(submitted), sub: scalar(c.assessmentPeriod) },
      { label: "Valid responses", value: String(valid), sub: `${validPct}% of submitted` },
      { label: "Excluded responses", value: String(n(c.responsesExcluded)), sub: `${n(c.dontKnowRatePct)}% don't-know` },
      {
        label: "Documents attached",
        value: String(n(c.evidenceFilesTotal)),
        sub: `${n(c.evidenceIncludedInReport)} in this report`,
      },
      { label: "Domains scored", value: String(n(c.domainsScored)) },
      { label: "KPIs scored", value: String(n(c.kpisScored)) },
      {
        label: "Flagged responses",
        value: String(n(c.duplicateResponses) + n(c.lowConfidenceResponses)),
        sub: `${n(c.duplicateResponses)} dup / ${n(c.lowConfidenceResponses)} low-conf`,
      },
    ],
  };
}

// Organisation-wide volumes (RPT15). Counts only — deliberately no severity or
// priority figures here, so a reader can't mistake volume for performance.
function portfolioStats(p: Record<string, unknown>): DocSection {
  return {
    kind: "stats",
    heading: "Organisation Portfolio",
    tiles: [
      { label: "Studies", value: String(n(p.studiesTotal)) },
      { label: "Needs", value: String(n(p.needsTotal)) },
      { label: "Surveys", value: String(n(p.surveysTotal)) },
      { label: "Survey links", value: String(n(p.publicLinksTotal)) },
      {
        label: "Responses (all studies)",
        value: String(n(p.responsesTotal)),
        sub: `this survey = ${n(p.thisSurveyShareOfResponsesPct)}%`,
      },
      { label: "Documents", value: String(n(p.evidenceFilesTotal)) },
      { label: "Reports", value: String(n(p.reportsTotal)) },
      { label: "Sharing requests", value: String(n(p.sharingRequestsTotal)) },
      { label: "Villages covered", value: String(n(p.villagesCovered)), sub: `${n(p.governoratesCovered)} governorate(s)` },
    ],
  };
}

// Survey vs organisation, as paired bars. Every metric is already on a 0-100
// scale, so one shared max keeps the comparison honest.
function comparisonSection(rows: Array<Record<string, unknown>>): DocSection {
  return {
    kind: "groupedBars",
    heading: "This Survey vs. Organisation",
    max: 100,
    groups: rows.map((r) => scalar(r.metric)),
    series: [
      { name: "This survey", values: rows.map((r) => n(r.surveyValue)) },
      { name: "Organisation", values: rows.map((r) => n(r.orgAverage)) },
    ],
  };
}

// Demographic (gender/rural) capture is pending — every core report degrades
// this chart gracefully rather than omitting it silently (see getDemographics).
const DEMOGRAPHICS_NOTE: DocSection = {
  kind: "note",
  heading: "Demographic Breakdown",
  text: "Not available — demographic (gender / rural) capture is pending. This chart will populate once demographic data is collected.",
};

export function buildReportDoc(
  title: string,
  content: Record<string, unknown>,
  audit: Array<{ label: string; value: string }>,
): ReportDoc {
  const headerBand = isPlainObject(content.header) ? kvRows(content.header) : [];
  // KEEP IN SYNC with the identical predicate in the frontend viewer
  // (Project-RIO-Frontend/src/components/features/reports/report-content-view.tsx).
  // If the two drift, a report renders rich in one place and as a flat key/value
  // dump in the other. `coverage`/`dashboard` are the survey-scoped reports
  // (RPT01/RPT15) — they always carry `severity` too, but listing them here
  // makes the intent explicit rather than incidental.
  const isCore =
    headerBand.length > 0 &&
    (isPlainObject(content.severity) ||
      isPlainObject(content.coverage) ||
      isPlainObject(content.dashboard) ||
      isObjectArray(content.domains) ||
      isObjectArray(content.regions) ||
      isObjectArray(content.topPriorities) ||
      isPlainObject(content.kpis) ||
      isObjectArray(content.scoringDistribution) ||
      isObjectArray(content.requests));

  const sections: DocSection[] = [];

  if (isCore) {
    // Survey identity first (RPT01/RPT15) — which survey, under which need.
    // Without it a survey-scoped report is indistinguishable from its sibling.
    if (isPlainObject(content.survey)) {
      const sv = content.survey as Record<string, unknown>;
      sections.push({
        kind: "keyvalue",
        heading: "Survey",
        rows: [
          { label: "Survey", value: scalar(sv.surveyTitle) },
          { label: "Status", value: scalar(sv.surveyStatus) },
          { label: "Need", value: scalar(sv.needStatement) },
          { label: "Village", value: scalar(sv.villageName) },
          { label: "Assessment Cycle", value: scalar(sv.assessmentCycle) },
          { label: "Assessment Period", value: scalar(sv.assessmentPeriod) },
          { label: "Methodology Version", value: scalar(sv.methodologyVersion) },
        ],
      });
    }

    // Coverage / portfolio count bands — the volume context for everything
    // that follows.
    if (isPlainObject(content.coverage)) sections.push(coverageStats(content.coverage));
    if (isPlainObject(content.portfolio)) sections.push(portfolioStats(content.portfolio));

    // Structured scope (Executive report) — Region / Governorate coverage,
    // shown up front rather than only mentioned in the narrative.
    if (isPlainObject(content.scope)) {
      const scope = content.scope as Record<string, unknown>;
      sections.push({
        kind: "keyvalue",
        heading: "Region / Governorate",
        rows: [
          { label: "Coverage", value: scalar(scope.villages) },
          { label: "Governorate", value: scalar(scope.governorate) },
        ],
      });
    }

    const rq: DocSection | null = isPlainObject(content.responseQuality)
      ? { kind: "keyvalue", heading: "Response Quality", rows: responseQualityRows(content.responseQuality) }
      : null;

    // Severity block → a Needs Index gauge (paired with Response Quality), a
    // Domain Profile radar + Severity bars side by side, and a compact table.
    let gauge: DocSection | null = null;
    let radar: DocSection | null = null;
    let bars: DocSection | null = null;
    let domainsTable: DocSection | null = null;
    const sev = isPlainObject(content.severity) ? content.severity : null;
    const domains = sev && isObjectArray(sev.domains) ? sev.domains : isObjectArray(content.domains) ? content.domains : null;
    if (sev) {
      const idx = Number(sev.overallVillageNeedsIndex);
      if (!Number.isNaN(idx)) {
        // The gauge's `value` is a raw number field (not routed through
        // scalar()), so it needs its own rounding — otherwise the dial shows
        // "46.19..." instead of a whole number like every other score in the app.
        gauge = { kind: "gauge", heading: "Needs Index", value: Math.round(idx), max: 100, sub: typeof sev.label === "string" ? sev.label : undefined };
      }
    }
    if (domains) {
      if (domains.length >= 3) radar = domainRadar(domains);
      bars = barsSection("Domain Severity (0-100)", domains, "name", "severityScore", 100);
      domainsTable = pickTableSection("Domains", domains, DOMAIN_TABLE_COLS);
    }

    // Row 1: gauge + response quality (or whichever exists).
    if (gauge && rq) sections.push({ kind: "columns", children: [gauge, rq] });
    else if (gauge) sections.push(gauge);
    else if (rq) sections.push(rq);

    // Row 2: radar + severity bars.
    if (radar && bars) sections.push({ kind: "columns", children: [radar, bars] });
    else if (bars) sections.push(bars);
    if (domainsTable) sections.push(domainsTable);

    // Per-domain trend notes — surfaced consistently for every domain (not just
    // one global note). One line per domain: "<Domain>: <trendNote>".
    if (domains && domains.some((d) => typeof d.trendNote === "string" && d.trendNote)) {
      sections.push({
        kind: "keyvalue",
        heading: "Domain Trend Notes",
        rows: domains
          .filter((d) => typeof d.trendNote === "string" && d.trendNote)
          .map((d) => ({ label: scalar(d.name), value: String(d.trendNote) })),
      });
    }

    if (isPlainObject(content.priority)) {
      sections.push({ kind: "keyvalue", heading: "Priority", rows: kvRows(content.priority) });
    }

    // Data-collection funnel + questionnaire weighting, side by side — both are
    // "how was this built" context, and pairing them keeps the page count down.
    const funnel: DocSection | null = isObjectArray(content.responseFunnel)
      ? barsSection(
          "Response Funnel",
          content.responseFunnel,
          "stage",
          "count",
          Math.max(1, ...content.responseFunnel.map((r) => Number(r.count) || 0)),
        )
      : null;
    const questionCoverage: DocSection | null = isObjectArray(content.questionCoverage)
      ? barsSection(
          "Questions per Domain",
          content.questionCoverage,
          "domain",
          "count",
          Math.max(1, ...content.questionCoverage.map((r) => Number(r.count) || 0)),
        )
      : null;
    if (funnel && questionCoverage) sections.push({ kind: "columns", children: [funnel, questionCoverage] });
    else if (funnel) sections.push(funnel);
    else if (questionCoverage) sections.push(questionCoverage);

    // ── RPT15's dashboard half ──
    if (isPlainObject(content.dashboard)) {
      const d = content.dashboard as Record<string, unknown>;
      const kpis = isPlainObject(d.kpis) ? d.kpis : null;

      // Provenance line: the two halves were captured at different moments and
      // must never read as simultaneous.
      sections.push({
        kind: "note",
        heading: "Organisation Dashboard",
        text: `Dashboard figures captured ${scalar(d.capturedAt)}. Survey figures are a frozen snapshot taken at generation time.`,
      });

      if (kpis) {
        const slaPct = kpis.slaCompliancePct;
        const slaGauge: DocSection | null =
          typeof slaPct === "number"
            ? { kind: "gauge", heading: "Reviewer SLA Compliance", value: Math.round(slaPct), max: 100, sub: "%" }
            : null;
        const kpiRows: DocSection = {
          kind: "keyvalue",
          heading: "Dashboard KPIs",
          rows: kvRows(kpis),
        };
        if (slaGauge) sections.push({ kind: "columns", children: [slaGauge, kpiRows] });
        else sections.push(kpiRows);
      }

      if (isObjectArray(d.scoringDistribution)) {
        const maxCount = Math.max(1, ...d.scoringDistribution.map((r) => Number(r.count) || 0));
        sections.push(barsSection("Organisation Scoring Distribution", d.scoringDistribution, "band", "count", maxCount));
      }
      if (isObjectArray(d.topPriorities)) {
        sections.push(tableSection("Organisation Top Priorities", d.topPriorities));
      }
      if (Array.isArray(d.anomalies) && d.anomalies.length) {
        sections.push({ kind: "list", heading: "Dashboard Anomalies", items: d.anomalies.map(String) });
      }
      if (isObjectArray(d.reviewerNotes)) {
        sections.push(tableSection("Reviewer Notes", d.reviewerNotes));
      }
    }

    // The reconciliation band — paired bars, then the exact figures beneath.
    if (isObjectArray(content.comparison)) {
      sections.push(comparisonSection(content.comparison));
      sections.push(tableSection("Comparison Detail", content.comparison));
    }
    // RPT02 Collective Dashboard.
    if (isPlainObject(content.kpis)) {
      sections.push({ kind: "keyvalue", heading: "Collective KPIs", rows: kvRows(content.kpis) });
    }
    if (isObjectArray(content.scoringDistribution)) {
      const maxCount = Math.max(1, ...content.scoringDistribution.map((r) => Number(r.count) || 0));
      sections.push(barsSection("Scoring Distribution", content.scoringDistribution, "band", "count", maxCount));
    }
    // RPT12 Report Sharing Status.
    if (isPlainObject(content.summary) && isObjectArray(content.requests)) {
      sections.push({ kind: "keyvalue", heading: "Sharing Summary", rows: kvRows(content.summary) });
    }
    if (isObjectArray(content.requests)) sections.push(tableSection("Sharing Requests", content.requests));
    if (isObjectArray(content.regions)) sections.push(tableSection("Regions", content.regions));
    if (isObjectArray(content.topKpis)) sections.push(pickTableSection("Top KPIs", content.topKpis, TOP_KPI_COLS));
    if (isObjectArray(content.topPriorities)) sections.push(tableSection("Top Priorities", content.topPriorities));

    // Demographic pies side by side. The Executive report may have an empty
    // topPriorities list, so also treat a report carrying Response Quality as a
    // needs report — otherwise it would silently drop the demographics
    // placeholder that every other needs report shows.
    const isNeedsReport =
      !!sev ||
      !!domains ||
      isObjectArray(content.regions) ||
      isObjectArray(content.topPriorities) ||
      isPlainObject(content.responseQuality);
    const demo = isPlainObject(content.demographics) ? content.demographics : null;
    const toSlices = (arr: Array<Record<string, unknown>>) => arr.map((r) => ({ label: scalar(r.label), value: Number(r.count) || 0 }));
    const genderPie: DocSection | null =
      demo && isObjectArray(demo.gender) ? { kind: "pie", heading: "Gender Breakdown", slices: toSlices(demo.gender) } : null;
    const ruralPie: DocSection | null =
      demo && isObjectArray(demo.rural) ? { kind: "pie", heading: "Rural / Urban Breakdown", slices: toSlices(demo.rural) } : null;
    if (genderPie && ruralPie) sections.push({ kind: "columns", children: [genderPie, ruralPie] });
    else if (genderPie) sections.push(genderPie);
    else if (ruralPie) sections.push(ruralPie);
    else if (isNeedsReport) sections.push(DEMOGRAPHICS_NOTE);

    if (isObjectArray(content.qualitativeEvidence)) {
      sections.push(tableSection("Qualitative Evidence", content.qualitativeEvidence));
    }
    if (isPlainObject(content.aiSummary)) sections.push(...aiSummarySections(content.aiSummary));
    // First-class Data Quality and Trend notes (promoted out of the AI Summary,
    // currently the region report) — rendered as their own labeled sections.
    if (typeof content.dataQualityNote === "string" && content.dataQualityNote) {
      sections.push({ kind: "note", heading: "Data Quality Note", text: content.dataQualityNote });
    }
    if (typeof content.trendNote === "string" && content.trendNote) {
      sections.push({ kind: "note", heading: "Trend Note", text: content.trendNote });
    }
    if (Array.isArray(content.anomalies) && content.anomalies.length) {
      sections.push({ kind: "list", heading: "Anomalies Flagged", items: content.anomalies.map(String) });
    }
    if (content.reviewerNotes) {
      sections.push({ kind: "note", heading: "Reviewer Notes", text: String(content.reviewerNotes) });
    }
  } else {
    // Placeholder / unknown shape — generic flatten.
    const flat = flattenReportContent(content);
    if (flat.summaryRows.length) {
      sections.push({
        kind: "keyvalue",
        heading: "Summary",
        rows: flat.summaryRows.map((r) => ({ label: r.field, value: r.value })),
      });
    }
    for (const t of flat.tables) sections.push(tableSection(titleCase(t.name), t.rows));
  }

  return { title, headerBand, sections, audit };
}
