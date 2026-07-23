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

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
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
    if (!isPlainObject(v) && !Array.isArray(v)) rows.push({ label: titleCase(k), value: scalar(v) });
  }
  return rows;
}

function tableSection(heading: string, arr: Array<Record<string, unknown>>): DocSection {
  const keys = [...new Set(arr.flatMap((o) => Object.keys(o)))];
  return {
    kind: "table",
    heading,
    columns: keys.map(titleCase),
    rows: arr.map((o) => keys.map((k) => scalar(o[k]))),
  };
}

// Table with an explicit column set + concise labels — keeps wide detail tables
// readable in the fixed-width PDF (long headers like "Performance Score" left
// the short values floating far away and looking misaligned).
interface Col {
  key: string;
  label: string;
}
function pickTableSection(heading: string, arr: Array<Record<string, unknown>>, cols: Col[]): DocSection {
  const present = cols.filter((c) => arr.some((o) => o[c.key] !== undefined));
  return {
    kind: "table",
    heading,
    columns: present.map((c) => c.label),
    rows: arr.map((o) => present.map((c) => scalar(o[c.key]))),
  };
}

const DOMAIN_TABLE_COLS: Col[] = [
  { key: "name", label: "Domain" },
  { key: "severityScore", label: "Severity" },
  { key: "performanceScore", label: "Performance" },
  { key: "weight", label: "Weight" },
  { key: "confidence", label: "Confidence" },
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
      .map((o) => ({ label: scalar(o[labelKey]), value: o[valueKey] as number })),
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
  const isCore =
    headerBand.length > 0 &&
    (isPlainObject(content.severity) ||
      isObjectArray(content.domains) ||
      isObjectArray(content.regions) ||
      isObjectArray(content.topPriorities) ||
      isPlainObject(content.kpis) ||
      isObjectArray(content.scoringDistribution) ||
      isObjectArray(content.requests));

  const sections: DocSection[] = [];

  if (isCore) {
    const rq: DocSection | null = isPlainObject(content.responseQuality)
      ? { kind: "keyvalue", heading: "Response Quality", rows: kvRows(content.responseQuality) }
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
        gauge = { kind: "gauge", heading: "Needs Index", value: idx, max: 100, sub: typeof sev.label === "string" ? sev.label : undefined };
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

    if (isPlainObject(content.priority)) {
      sections.push({ kind: "keyvalue", heading: "Priority", rows: kvRows(content.priority) });
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

    // Demographic pies side by side.
    const isNeedsReport =
      !!sev || !!domains || isObjectArray(content.regions) || isObjectArray(content.topPriorities);
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
