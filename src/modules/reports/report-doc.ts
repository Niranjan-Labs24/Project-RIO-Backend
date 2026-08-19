import { flattenReportContent } from "./report-content-flatten";
import { severityBandOf } from "./providers/severity-bands";

// Normalized, render-agnostic report document. The PDF and Excel renderers
// both consume this, so layout logic lives in one place and the two exports
// stay in sync. buildReportDoc maps each report's `content` (see the
// generators) into these sections; unknown/placeholder shapes fall back to the
// generic flatten path.

// ── Drill-down ──
//
// The client's requirement is that the interactivity survives EXPORT: a shared
// PDF must still drill, not just the web view. So a drill target is modelled as
// a symbolic anchor id on the document, and each renderer realises it in its
// own idiom — PDF link annotations (/Annots + /GoTo), Excel HYPERLINK() to a
// sheet, and accordion/navigation on screen. One contract, three surfaces:
// anything else lets the surfaces drift apart.
//
// Anchor ids are derived from stable domain keys (domain code, indicator id),
// never array positions, so regenerating a report keeps the same internal
// structure and two runs stay diffable.

/** Registers the current position as a jump target. Draws nothing itself. */
export interface DocAnchor {
  kind: "anchor";
  id: string;
}

/** A clickable tile — the index-grid affordance from the reference artefact. */
export interface DocTile {
  label: string;
  sub: string;
  /** Anchor id this tile jumps to. */
  to: string;
}

export type DocSection =
  | { kind: "keyvalue"; heading: string; rows: Array<{ label: string; value: string }> }
  // `rowLinks[i]` is the anchor id row i drills into (null = not clickable).
  // Optional so every existing table section keeps working untouched.
  | {
      kind: "table";
      heading: string;
      columns: string[];
      rows: string[][];
      rowLinks?: Array<string | null>;
    }
  | DocAnchor
  // Grid of clickable tiles — the drill-down index.
  | { kind: "navGrid"; heading: string; tiles: DocTile[] }
  // Forces a physical page break and registers an anchor for it. Drill targets
  // are MATERIALISED pages in the PDF: there is no lazy loading in a PDF, so
  // every target must exist as a page before it can be linked to.
  | { kind: "pageBreak"; anchorId: string; heading?: string }
  // "Back to …" trail, drawn at the top of a detail page.
  | { kind: "breadcrumb"; trail: Array<{ label: string; to?: string }> }
  | { kind: "bars"; heading: string; max: number; bars: Array<{ label: string; value: number }> }
  // `emphasis` renders the chart large and centred with its legend beneath,
  // rather than small with the legend beside it. For a figure that is the point
  // of its section rather than one of several on a page.
  | {
      kind: "pie";
      heading: string;
      slices: Array<{ label: string; value: number }>;
      emphasis?: boolean;
    }
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
  // `weights` is an optional width ratio — a chart beside a long key/value block
  // wants the narrower half, not an even split.
  | { kind: "columns"; children: DocSection[]; weights?: number[] };

/** One collapsible chapter of a report. */
export interface DocChapter {
  /** Box label on the contents page. */
  name: string;
  /** One-line descriptor under the label — what the reader will find inside. */
  summary: string;
  sections: DocSection[];
}

export interface ReportDoc {
  title: string;
  headerBand: Array<{ label: string; value: string }>;
  sections: DocSection[];
  audit: Array<{ label: string; value: string }>;
  /**
   * Present when the report is laid out as collapsible chapters: the PDF
   * renderer draws each one into its own hidden layer, revealed by clicking its
   * box on the contents page. `sections` still carries the same content in
   * reading order, so Excel and the on-screen viewer are unaffected.
   */
  chapters?: DocChapter[];
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

// Response Quality rows. The confidence BAND, the REASON it was assigned, and
// the valid-response RATE are three separate rows — folding them into
// "STANDARD (90%)" read as "90% confident", which is a claim none of the three
// numbers makes.
const RESPONSE_QUALITY_ROWS: Array<{ key: string; label: string; format?: (v: unknown) => string }> = [
  { key: "overallConfidence", label: "Overall confidence" },
  { key: "confidenceReason", label: "Why this band" },
  { key: "submittedResponses", label: "Responses submitted" },
  { key: "validResponses", label: "Valid responses" },
  { key: "validResponseRatePct", label: "Valid-response rate", format: (v) => `${scalar(v)}%` },
  {
    key: "dontKnowRate",
    label: "Don't-know rate",
    format: (v) => (typeof v === "number" ? `${v.toFixed(2)}%` : scalar(v)),
  },
  { key: "dontKnowBand", label: "Don't-know band" },
  // RIO-FR-024: the study's own signed-off sample-size target — renders "—"
  // (via scalar()'s null handling) for studies created before this field
  // existed, same as every other nullable figure in this report.
  { key: "population", label: "Population (area)" },
  { key: "requiredSampleSize", label: "Required sample size" },
  {
    key: "minimumDetectableEffect",
    label: "Minimum detectable effect",
    format: (v) => (typeof v === "number" ? `±${v.toFixed(1)} pts` : scalar(v)),
  },
];

function responseQualityRows(obj: Record<string, unknown>): Array<{ label: string; value: string }> {
  const known = new Set(RESPONSE_QUALITY_ROWS.map((r) => r.key));
  const rows = RESPONSE_QUALITY_ROWS.filter((r) => obj[r.key] !== undefined).map((r) => ({
    label: r.label,
    value: r.format ? r.format(obj[r.key]) : scalar(obj[r.key], r.key),
  }));
  // Anything a future field adds still shows, rather than silently vanishing.
  for (const [k, v] of Object.entries(obj)) {
    if (known.has(k) || isPlainObject(v) || Array.isArray(v)) continue;
    rows.push({ label: titleCase(k), value: scalar(v, k) });
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
function pickTableSection(
  heading: string,
  arr: Array<Record<string, unknown>>,
  cols: Col[],
  // Anchor id per row — the drill target that row opens. Optional so every
  // existing call site is unaffected.
  rowLinks?: Array<string | null>,
): DocSection {
  const present = cols.filter((c) => arr.some((o) => o[c.key] !== undefined));
  return {
    kind: "table",
    heading,
    columns: present.map((c) => c.label),
    rows: arr.map((o) => present.map((c) => (c.format ? c.format(o) : scalar(o[c.key], c.key)))),
    ...(rowLinks ? { rowLinks } : {}),
  };
}

// ── Drill-down ──────────────────────────────────────────────────────────────
//
// Anchor ids are derived from STABLE methodology keys (domain code, indicator
// id), never from array position, so a regenerated report keeps the same
// internal link structure and two runs stay comparable.

// Anchor ids are NAMESPACED by report. In a combined export two reports can
// easily both contain domain HEALTH; without the prefix the first one's page
// wins the id and every link in the second silently jumps into the first
// report's section. The reader would have no way to tell that had happened.
const domainAnchor = (domainKey: unknown, ns = ""): string => `${ns}domain:${String(domainKey)}`;
const indicatorAnchor = (indicatorId: unknown, ns = ""): string =>
  `${ns}indicator:${String(indicatorId)}`;
/** Per-report prefix, e.g. "RPT14/". Empty for a single-report export. */
const nsOf = (reportKey?: string): string => (reportKey ? `${reportKey}/` : "");

/**
 * Materialised detail pages for the domain → sub-domain → indicator drill.
 *
 * A PDF has no lazy loading: every target a link jumps to has to physically
 * exist as a page in the same file. That is the cost of the interactivity
 * surviving export, and it is why these pages are built up front rather than
 * fetched on click.
 *
 * The payload is the detail the summary sections deliberately omit — the
 * client's "collapsed on screen, revealed on click" principle, applied to a
 * medium that cannot collapse.
 */
function drillDownSections(domains: Array<Record<string, unknown>>, ns = ""): DocSection[] {
  const out: DocSection[] = [];

  // The index grid — the reference artefact's page 1.
  out.push({
    kind: "navGrid",
    heading: "Drill-down Index — Domains",
    tiles: domains.map((d) => {
      const subs = (d.subDomains as Array<Record<string, unknown>>) ?? [];
      const indicators = subs.reduce(
        (sum, sub) => sum + (((sub.indicators as unknown[]) ?? []).length),
        0,
      );
      return {
        label: String(d.domain),
        sub: `${subs.length} sub-domain(s) · ${indicators} indicator(s)`,
        to: domainAnchor(d.domainKey, ns),
      };
    }),
  });

  for (const d of domains) {
    const subs = (d.subDomains as Array<Record<string, unknown>>) ?? [];
    out.push({
      kind: "pageBreak",
      anchorId: domainAnchor(d.domainKey, ns),
      heading: `${String(d.domain)} — Domain Detail`,
    });
    out.push({
      kind: "breadcrumb",
      trail: [{ label: "Drill-down Index", to: drillIndexAnchor(ns) }, { label: String(d.domain) }],
    });
    out.push({
      kind: "keyvalue",
      heading: "",
      rows: [
        { label: "Severity", value: severityCell(d) },
        { label: "Confidence", value: scalar(d.confidence) },
        { label: "Why this band", value: scalar(d.confidenceReason) },
        { label: "Weight", value: scalar(d.weight) },
        { label: "Weighted Contribution", value: scalar(d.weightedContribution) },
        {
          label: "Coverage",
          value: `${n(d.kpisScored)} of ${n(d.kpisAsked)} indicators measured; ${n(d.kpisDefined)} defined in the methodology`,
        },
        { label: "Questions Asked", value: scalar(d.questionsAsked) },
        { label: "Trend", value: scalar(d.trendNote) },
      ],
    });

    // Sub-domain → indicator breakdown, with each indicator drilling one level
    // further into its own KPI/scoring detail.
    const indicatorRows: Array<Record<string, unknown>> = [];
    const indicatorLinks: Array<string | null> = [];
    for (const sub of subs) {
      for (const ind of ((sub.indicators as Array<Record<string, unknown>>) ?? [])) {
        indicatorRows.push({
          subDomain: sub.subDomain,
          indicatorName: ind.indicatorName,
          severityScore: ind.severityScore,
          confidence: ind.confidence,
          kpiCount: ((ind.needs as unknown[]) ?? []).length,
        });
        indicatorLinks.push(indicatorAnchor(ind.indicatorId, ns));
      }
    }
    if (indicatorRows.length) {
      out.push(
        pickTableSection("Sub-domains and Indicators", indicatorRows, SUBDOMAIN_COLS, indicatorLinks),
      );
    }

    // Indicator leaf pages — the deepest level, carrying the scoring detail
    // (raw severity, band, confidence trigger, equity, gap type, exclusions).
    for (const sub of subs) {
      for (const ind of ((sub.indicators as Array<Record<string, unknown>>) ?? [])) {
        const needs = (ind.needs as Array<Record<string, unknown>>) ?? [];
        out.push({
          kind: "pageBreak",
          anchorId: indicatorAnchor(ind.indicatorId, ns),
          heading: `${String(ind.indicatorName)} — Indicator Detail`,
        });
        out.push({
          kind: "breadcrumb",
          trail: [
            { label: "Drill-down Index", to: drillIndexAnchor(ns) },
            { label: String(d.domain), to: domainAnchor(d.domainKey, ns) },
            { label: String(sub.subDomain) },
            { label: String(ind.indicatorName) },
          ],
        });
        out.push({
          kind: "keyvalue",
          heading: "",
          rows: [
            { label: "Domain", value: String(d.domain) },
            { label: "Sub-domain", value: String(sub.subDomain) },
            { label: "Indicator ID", value: scalar(ind.indicatorId) },
            { label: "Severity", value: severityCell(ind) },
            { label: "Confidence", value: scalar(ind.confidence) },
          ],
        });
        if (needs.length) {
          // The KPI rows beneath this indicator — question-level scoring
          // detail, which is exactly the "raw vs. calibrated" payload the
          // client asked the drill to reveal.
          out.push(pickTableSection("KPIs under this Indicator", needs, NEED_RECORD_COLS_FULL));
        }
      }
    }
  }

  return out;
}

/** Anchor for the drill index itself, so every detail page can link back. */
const drillIndexAnchor = (ns = ""): string => `${ns}drill:index`;

const SUBDOMAIN_COLS: Col[] = [
  { key: "subDomain", label: "Sub-domain" },
  { key: "indicatorName", label: "Indicator" },
  { key: "severityScore", label: "Severity", format: severityCell },
  { key: "confidence", label: "Confidence" },
  { key: "kpiCount", label: "KPIs" },
];

const DOMAIN_TABLE_COLS: Col[] = [
  { key: "name", label: "Domain" },
  // Methodology domain code — maps the row back to the methodology indicators.
  { key: "domainCode", label: "Code" },
  // 2 decimals, matching the Calculation Basis working line for the same domain.
  { key: "severityScore", label: "Severity", format: severityCell },
  {
    key: "performanceScore",
    label: "Performance",
    format: (o) =>
      typeof o.performanceScore === "number" ? o.performanceScore.toFixed(2) : scalar(o.performanceScore),
  },
  { key: "weight", label: "Weight" },
  // KPIs the METHODOLOGY defines under this domain — not the number this survey
  // measured, which the hierarchy section states per domain. Labelled so the two
  // figures cannot be read as the same thing.
  { key: "kpiCount", label: "KPIs defined" },
  // Band and rate are separate columns — see responseQualityRows.
  { key: "confidence", label: "Confidence" },
  { key: "validResponseRatePct", label: "Valid %" },
  { key: "isCriticalDomain", label: "Critical" },
];

// ── RPT03 / RPT09 Top-Priority ──

const TIER_SUMMARY_COLS: Col[] = [
  { key: "tier", label: "Priority Tier" },
  { key: "count", label: "Needs" },
  { key: "sharePct", label: "Share", format: (o) => `${scalar(o.sharePct)}%` },
  // The methodology promotes an equity-flagged need a tier, so showing how many
  // of each tier arrived there via equity keeps the banding auditable.
  { key: "equityFlagged", label: "Equity-flagged" },
];

const DOMAIN_ROLLUP_COLS: Col[] = [
  { key: "domain", label: "Domain" },
  {
    key: "averageSeverity",
    label: "Avg Severity",
    format: (o) => (typeof o.averageSeverity === "number" ? o.averageSeverity.toFixed(2) : "—"),
  },
  // The no-masking column. A domain can average LOW while hiding a CRITICAL
  // KPI; printing the max next to the average is that rule in table form.
  {
    key: "maxKpiSeverity",
    label: "Max KPI Severity",
    format: (o) => (typeof o.maxKpiSeverity === "number" ? o.maxKpiSeverity.toFixed(2) : "—"),
  },
  { key: "criticalKpiCount", label: "Critical KPIs" },
  { key: "kpiCount", label: "KPIs Defined" },
  {
    key: "masksCriticalFinding",
    label: "Masking?",
    format: (o) => (o.masksCriticalFinding === true ? "YES — read Max, not Avg" : "No"),
  },
];

// ── RPT10 Data-Quality ──

const DOMAIN_CONFIDENCE_COLS: Col[] = [
  { key: "domain", label: "Domain" },
  { key: "confidence", label: "Confidence" },
  { key: "validResponseRatePct", label: "Valid-Response Rate", format: (o) => `${scalar(o.validResponseRatePct)}%` },
  { key: "dontKnowRatePct", label: "Don't-Know Rate", format: (o) => `${scalar(o.dontKnowRatePct)}%` },
  { key: "kpiCount", label: "KPIs" },
  // Names the condition that actually fired, so a LOW band is never left
  // looking arbitrary.
  { key: "reason", label: "Why this band" },
];

const FLAGGED_RECORD_COLS: Col[] = [
  { key: "flag", label: "Flag" },
  { key: "domain", label: "Domain" },
  { key: "indicatorName", label: "Indicator" },
  { key: "reason", label: "Reason" },
];

// ── RPT06 Region ──

const GOVERNORATE_COLS: Col[] = [
  { key: "governorate", label: "Governorate" },
  { key: "needCount", label: "Needs" },
  { key: "responseCount", label: "Responses" },
  {
    key: "severityScore",
    label: "Avg Severity",
    format: (o) => (typeof o.severityScore === "number" ? o.severityScore.toFixed(2) : "—"),
  },
  // The no-masking column: a governorate can average Low while containing a
  // critical village, so the worst village is printed beside the mean.
  {
    key: "maxVillageSeverity",
    label: "Worst Village",
    format: (o) => (typeof o.maxVillageSeverity === "number" ? o.maxVillageSeverity.toFixed(2) : "—"),
  },
  {
    key: "priorityScore",
    label: "Priority",
    format: (o) => (typeof o.priorityScore === "number" ? o.priorityScore.toFixed(2) : "—"),
  },
  { key: "priorityStatus", label: "Status" },
];

const REGION_VILLAGE_COLS: Col[] = [
  { key: "village", label: "Village" },
  { key: "governorate", label: "Governorate" },
  { key: "needCount", label: "Needs" },
  { key: "responseCount", label: "Responses" },
  { key: "severityScore", label: "Severity", format: severityCell },
  {
    key: "priorityScore",
    label: "Priority",
    format: (o) => (typeof o.priorityScore === "number" ? o.priorityScore.toFixed(2) : "—"),
  },
  { key: "priorityStatus", label: "Status" },
];

const TOP_KPI_COLS: Col[] = [
  { key: "rank", label: "#" },
  { key: "kpi", label: "KPI" },
  { key: "domain", label: "Domain" },
  // The severity column is ALWAYS present. An unmeasured KPI shows "—" plus the
  // reason, never a 0 and never a hidden row.
  { key: "severityScore", label: "Severity", format: severityCell },
  { key: "confidence", label: "Confidence" },
  { key: "validResponseCount", label: "Responses" },
  { key: "notMeasuredReason", label: "Why not measured" },
];

// Severity is printed to 2 decimals in every need table, matching the
// Calculation Basis working exactly — a table reading 51 beside a working line
// reading 51.04 invites the reader to wonder which is the real figure.
function severityCell(o: Record<string, unknown>): string {
  const v = o.severityScore;
  if (v === null || v === undefined) return "—";
  return typeof v === "number" ? v.toFixed(2) : scalar(v);
}

// Why this row carries no severity, or why its equity check could not run.
// Without it a blank Equity "No" reads as "checked, no inequity found".
function needNotes(o: Record<string, unknown>): string {
  if (typeof o.notMeasuredReason === "string" && o.notMeasuredReason) return o.notMeasuredReason;
  const eq = o.equityDetail;
  if (isPlainObject(eq) && eq.evaluable === false && typeof eq.reason === "string") {
    return `Equity not evaluable: ${eq.reason}`;
  }
  return "";
}

// One row per Unified Need Record. Severity is ALWAYS shown; when null it is a
// dash, and the reason is carried by the Not Measured table and Section 6 —
// these tables no longer print a Notes column, which repeated the same
// suppression sentence on every row.
//
// Compact set, for tables already nested under a named domain — the fixed-width
// PDF truncates a wide table's cells ("Livelih..", "structu.."), which is worse
// than omitting a column the surrounding heading already states.
const NEED_RECORD_COLS: Col[] = [
  { key: "indicatorName", label: "Indicator" },
  { key: "severityScore", label: "Severity", format: severityCell },
  { key: "severityBand", label: "Band" },
  { key: "confidence", label: "Confidence" },
  { key: "equityFlag", label: "Equity" },
  { key: "validResponseCount", label: "Responses" },
];

/** Full classification — used only where the rows span several domains. */
const NEED_RECORD_COLS_FULL: Col[] = [
  { key: "domain", label: "Domain" },
  { key: "subDomain", label: "Sub-domain" },
  ...NEED_RECORD_COLS,
];

// The Not Measured table exists to state WHY a row carries no severity, so it
// keeps the reason column the measured-need tables drop. Without it the table
// would be a list of indicators with no explanation attached.
const NOT_MEASURED_NEED_COLS: Col[] = [
  ...NEED_RECORD_COLS_FULL,
  { key: "notMeasuredReason", label: "Why not measured", format: needNotes },
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
function coverageStats(c: Record<string, unknown>, surveyOnly: boolean): DocSection {
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
      // A SURVEY-ONLY report contributes no document evidence to any figure in
      // it, so a tile reading "12 documents · 3 in this report" directly
      // contradicts the Report Basis line three inches above it. The count is
      // still in the payload; it is simply not this report's evidence.
      ...(surveyOnly
        ? []
        : [
            {
              label: "Documents attached",
              value: String(n(c.evidenceFilesTotal)),
              sub: `${n(c.evidenceIncludedInReport)} in this report`,
            },
          ]),
      { label: "Domains scored", value: String(n(c.domainsScored)) },
      {
        label: "KPIs scored",
        value: String(n(c.kpisScored)),
        // Attempted-but-unmeasurable KPIs are counted separately: folding them
        // into "scored" is what let 9 KPIs report as 8 results with no trace.
        sub: `${n(c.kpisAttempted)} asked · ${n(c.kpisNotMeasurable)} not measurable`,
      },
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
/**
 * Uploaded evidence documents plus each document's AI summary.
 *
 * Metadata first (file/type/reference/date/summary status) so the export carries
 * the provenance of every document, then one narrative block per document.
 */
function evidenceSections(evidence: Record<string, unknown>): DocSection[] {
  const out: DocSection[] = [];
  const docs = isObjectArray(evidence.documents) ? evidence.documents : [];

  // Mirrors the "Evidence Base" tile row in the viewer. A PDF cannot show the
  // status donut or the bar lists, so the same figures are carried as stats and
  // tables — the information parity is what matters, not the mark.
  const withSummary = docs.filter((d) => isPlainObject(d.aiSummary)).length;
  const confirmed = docs.filter((d) => scalar(d.summaryStatus) === "OFFICER_CONFIRMED").length;
  out.push({
    kind: "stats",
    heading: "Evidence Documents",
    tiles: [
      { label: "Total Documents", value: String(evidence.totalDocuments ?? docs.length) },
      { label: "With AI summary", value: String(withSummary) },
      { label: "Officer confirmed", value: String(confirmed) },
    ],
  });

  // Counts behind the viewer's status donut and the two bar lists.
  const tally = (pick: (d: Record<string, unknown>) => string) => {
    const m = new Map<string, number>();
    for (const d of docs) {
      const k = pick(d);
      if (!k || k === "—") continue;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const byStatus = tally((d) => scalar(d.summaryStatus) || "NO_SUMMARY");
  if (byStatus.length) {
    out.push(
      tableSection(
        "Summary Status Breakdown",
        byStatus.map(([status, count]) => ({
          Status: status.replace(/_/g, " "),
          Documents: count,
          "% of documents": docs.length ? `${Math.round((count / docs.length) * 100)}%` : "0%",
        })),
      ),
    );
  }

  const byType = tally((d) => scalar(d.documentType));
  if (byType.length) {
    out.push(
      tableSection(
        "Documents by Type",
        byType.map(([type, count]) => ({ Type: type, Documents: count })),
      ),
    );
  }

  // Themes counted ACROSS documents, same as the viewer's theme bars, so a
  // theme several documents raise outranks a one-off.
  const themeCounts = new Map<string, number>();
  for (const d of docs) {
    const ai = isPlainObject(d.aiSummary) ? (d.aiSummary as Record<string, unknown>) : null;
    if (!ai || !Array.isArray(ai.themes)) continue;
    for (const th of ai.themes) {
      const name = isPlainObject(th) ? scalar((th as Record<string, unknown>).theme) : String(th);
      if (!name || name === "—") continue;
      themeCounts.set(name, (themeCounts.get(name) ?? 0) + 1);
    }
  }
  if (themeCounts.size) {
    out.push(
      tableSection(
        "Themes Across Documents",
        [...themeCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([theme, count]) => ({ Theme: theme, Documents: count })),
      ),
    );
  }

  if (docs.length) {
    out.push(
      tableSection(
        "Evidence Document Register",
        docs.map((d) => ({
          Title: scalar(d.title),
          Type: scalar(d.documentType),
          Reference: scalar(d.sourceReferenceId),
          Collected: scalar(d.collectedDate),
          "Summary Status": scalar(d.summaryStatus),
        })),
      ),
    );
  }

  for (const doc of docs) {
    const ai = isPlainObject(doc.aiSummary) ? (doc.aiSummary as Record<string, unknown>) : null;
    if (!ai) continue;
    const heading = `Evidence Summary — ${scalar(doc.title)}`;

    // The qualitative guardrail note the viewer shows above each summary.
    if (typeof ai.evidenceNote === "string" && ai.evidenceNote) {
      out.push({ kind: "note", heading: `${heading} — Basis`, text: ai.evidenceNote });
    }
    if (typeof ai.summary === "string" && ai.summary) {
      out.push({ kind: "note", heading, text: ai.summary });
    }

    const findings = Array.isArray(ai.keyFindings) ? ai.keyFindings : [];
    if (findings.length) {
      out.push({
        kind: "list",
        heading: `${heading} — Key Findings`,
        items: findings.map((f) =>
          isPlainObject(f) ? scalar((f as Record<string, unknown>).finding) : String(f),
        ),
      });
    }

    // Themes, supporting statements, risks and limitations all render in the
    // viewer but were dropped from every export — the reader of the PDF saw a
    // strictly smaller report than the reader of the screen.
    if (Array.isArray(ai.themes) && ai.themes.length) {
      out.push(
        tableSection(
          `${heading} — Themes`,
          ai.themes.map((th) => {
            const t = isPlainObject(th) ? (th as Record<string, unknown>) : null;
            return {
              Theme: t ? scalar(t.theme) : String(th),
              Description: t ? scalar(t.description) : "",
              Reference: t ? scalar(t.sourceReferenceId) : "",
            };
          }),
        ),
      );
    }

    if (Array.isArray(ai.supportingStatements) && ai.supportingStatements.length) {
      out.push({
        kind: "list",
        heading: `${heading} — Supporting Statements`,
        items: ai.supportingStatements.map((st) => {
          const s = isPlainObject(st) ? (st as Record<string, unknown>) : null;
          if (!s) return String(st);
          const ref = scalar(s.sourceReferenceId);
          const loc = scalar(s.pageOrSection ?? s.sectionOrPageRef);
          const cite = [ref, loc].filter((x) => x && x !== "—").join(", ");
          return cite ? `"${scalar(s.statement)}" (${cite})` : `"${scalar(s.statement)}"`;
        }),
      });
    }

    if (Array.isArray(ai.risksOrConcerns) && ai.risksOrConcerns.length) {
      out.push({
        kind: "list",
        heading: `${heading} — Risks / Concerns`,
        items: ai.risksOrConcerns.map((r) =>
          isPlainObject(r) ? scalar((r as Record<string, unknown>).concern) : String(r),
        ),
      });
    }

    if (Array.isArray(ai.documentLimitations) && ai.documentLimitations.length) {
      out.push({
        kind: "list",
        heading: `${heading} — Document Limitations`,
        items: ai.documentLimitations.map((l) => String(l)),
      });
    }
  }

  return out;
}

/**
 * The score-based AI narrative (RPT16). The combined report is the union of the
 * score report and the evidence report, so the exported document carries this
 * in full alongside the combined narrative. No `recommendations` block here —
 * both summaries' lists are hoisted into one de-duplicated top-level section.
 */
function scoreSummarySections(score: Record<string, unknown>): DocSection[] {
  const out: DocSection[] = [];

  if (typeof score.executiveSummary === "string" && score.executiveSummary) {
    out.push({ kind: "note", heading: "Score-Based Executive Summary", text: score.executiveSummary });
  }

  if (typeof score.priorityExplanation === "string" && score.priorityExplanation) {
    out.push({ kind: "note", heading: "Priority Explanation", text: score.priorityExplanation });
  }

  if (isObjectArray(score.keyFindings)) {
    out.push(
      tableSection(
        "Score-Based Key Findings",
        score.keyFindings.map((f) => ({
          Finding: scalar(f.title),
          Domain: scalar(f.domain),
          KPI: scalar(f.kpi),
          Severity: scalar(f.severityScore),
          Confidence: scalar(f.confidence),
          Summary: scalar(f.summary),
        })),
      ),
    );
  }

  if (isObjectArray(score.domainInsights)) {
    out.push(
      tableSection(
        "Domain Insights",
        score.domainInsights.map((d) => ({
          Domain: scalar(d.domain),
          Severity: scalar(d.severityScore),
          Performance: scalar(d.performanceScore),
          "Priority Contribution": scalar(d.priorityContribution),
          Confidence: scalar(d.confidence),
          Summary: scalar(d.summary),
        })),
      ),
    );
  }

  if (typeof score.criticalOverrideNote === "string" && score.criticalOverrideNote) {
    out.push({ kind: "note", heading: "Critical Override", text: score.criticalOverrideNote });
  }

  if (typeof score.dataQualityNote === "string" && score.dataQualityNote) {
    out.push({ kind: "note", heading: "Data Quality", text: score.dataQualityNote });
  }

  return out;
}

/**
 * The combined AI narrative (RPT16). Quantitative and qualitative halves stay in
 * separate blocks, mirroring the rule the generating prompt enforces.
 */
function combinedSummarySections(combined: Record<string, unknown>): DocSection[] {
  const out: DocSection[] = [];

  if (typeof combined.executiveSummary === "string" && combined.executiveSummary) {
    out.push({
      kind: "note",
      heading: "Combined Executive Summary",
      text: combined.executiveSummary,
    });
  }

  if (isPlainObject(combined.scoreBasedFindings)) {
    const s = combined.scoreBasedFindings as Record<string, unknown>;
    out.push({
      kind: "keyvalue",
      heading: "Score-Based Findings",
      rows: [
        { label: "Overall Severity Score", value: scalar(s.overallSeverityScore) },
        { label: "Priority Score", value: scalar(s.priorityScore) },
        { label: "Priority Status", value: scalar(s.priorityStatus) },
        { label: "Confidence / Data Quality", value: scalar(s.confidenceDataQualityNote) },
      ],
    });
    if (isObjectArray(s.topDomainsOrKpis)) {
      out.push(
        tableSection(
          "Top Domains / KPIs",
          s.topDomainsOrKpis.map((d) => ({ Name: scalar(d.name), Score: scalar(d.score) })),
        ),
      );
    }
  }

  if (isObjectArray(combined.documentBasedEvidence)) {
    out.push(
      tableSection(
        "Document-Based Evidence",
        combined.documentBasedEvidence.map((e) => ({
          Document: scalar(e.documentTitle),
          Reference: scalar(e.sourceReferenceId),
          "Linked Need / Domain": scalar(e.linkedNeedOrDomain),
          Finding: scalar(e.keyEvidenceFinding),
        })),
      ),
    );
  }

  if (isObjectArray(combined.domainKpiResults)) {
    out.push(
      tableSection(
        "Domain / KPI Results",
        combined.domainKpiResults.map((d) => ({
          Domain: scalar(d.domainName),
          Severity: scalar(d.severity),
          Performance: scalar(d.performance),
          Weight: scalar(d.weight),
          Confidence: scalar(d.confidence),
        })),
      ),
    );
  }

  return out;
}

const DEMOGRAPHICS_NOTE: DocSection = {
  kind: "note",
  heading: "Demographic Breakdown",
  text: "Not available — demographic (gender / rural) capture is pending. This chart will populate once demographic data is collected.",
};

// ── The six Unified Narrative sections (RPT01) ──
//
// Rendered only when the content actually carries them, so v1 reports already
// released keep rendering exactly as before — no backfill, no re-render of
// archival records.

function reportBasisSection(meta: Record<string, unknown>): DocSection {
  return {
    kind: "keyvalue",
    heading: "Report Basis",
    rows: [
      { label: "Report type", value: `${scalar(meta.reportType)} — ${scalar(meta.reportTypeName)}` },
      // The client's "clearly marked quantitative" requirement: a reader must
      // never have to infer what this report rests on.
      { label: "Source basis", value: "SURVEY-ONLY — derived from survey responses, no document evidence" },
      { label: "Evidence type", value: "QUANTITATIVE — every finding carries a measured severity score or an explicit reason it has none" },
    ],
  };
}

function executiveSummarySections(es: Record<string, unknown>): DocSection[] {
  const out: DocSection[] = [];
  out.push({
    kind: "stats",
    heading: "Executive Summary",
    tiles: [
      { label: "Needs extracted", value: String(n(es.totalNeedsExtracted)), sub: `${n(es.measuredCount)} measured · ${n(es.notMeasurableCount)} not measurable` },
      { label: "Quantitative", value: String(n(es.quantitativeCount)) },
      { label: "Qualitative", value: String(n(es.qualitativeCount)), sub: "survey-only report" },
      {
        label: "Domains assessed",
        value: String(n(es.domainsAssessed)),
        sub: `of ${n(es.domainsInMethodology)} in the methodology`,
      },
    ],
  });
  if (typeof es.coverageStatement === "string" && es.coverageStatement) {
    out.push({ kind: "note", heading: "Coverage", text: es.coverageStatement });
  }
  // EVERY methodology domain, assessed or not. Listing only the covered ones
  // let a reader infer full coverage of a nine-domain methodology.
  if (isObjectArray(es.domainDistribution)) {
    out.push(
      pickTableSection("Domain Coverage (all methodology domains)", es.domainDistribution, [
        { key: "domain", label: "Domain" },
        { key: "assessed", label: "Assessed" },
        {
          key: "severityScore",
          label: "Severity",
          format: severityCell,
        },
        { key: "severityBand", label: "Band" },
        { key: "needCount", label: "Indicators" },
        {
          key: "subDomainsAssessed",
          label: "Sub-domains",
          format: (o) => `${scalar(o.subDomainsAssessed)} / ${scalar(o.subDomainsDefined)}`,
        },
      ]),
    );
  }
  if (isObjectArray(es.topThreeCriticalNeeds)) {
    const heading = es.noCriticalBandReached === true ? "Top 3 Highest-Severity Needs" : "Top 3 Critical Needs";
    out.push(pickTableSection(heading, es.topThreeCriticalNeeds, NEED_RECORD_COLS_FULL));
  }
  if (typeof es.topNeedsShortfallReason === "string" && es.topNeedsShortfallReason) {
    out.push({ kind: "note", heading: "Why fewer than three", text: es.topNeedsShortfallReason });
  }
  return out;
}

// Domain → sub-domain → indicator, flattened into an indented table. The PDF
// renderer has no tree primitive, so nesting is carried by the label prefix —
// but every level is present, which is the client's actual requirement.
function needsByDomainSection(domains: Array<Record<string, unknown>>): DocSection {
  const rows: string[][] = [];
  for (const d of domains) {
    rows.push([
      String(d.domain),
      "DOMAIN",
      severityCell(d),
      scalar(d.confidence),
      `${n(d.kpisScored)} of ${n(d.kpisAsked)} indicators measured · ${n(d.questionsAsked)} questions asked`,
    ]);
    for (const s of (d.subDomains as Array<Record<string, unknown>>) ?? []) {
      rows.push([
        `  ${String(s.subDomain)}`,
        "SUB-DOMAIN",
        severityCell(s),
        scalar(s.confidence),
        "",
      ]);
      for (const i of (s.indicators as Array<Record<string, unknown>>) ?? []) {
        const needs = (i.needs as Array<Record<string, unknown>>) ?? [];
        const unmeasured = needs.find((x) => x.severityScore === null);
        rows.push([
          `    ${String(i.indicatorName)}`,
          "INDICATOR",
          severityCell(i),
          scalar(i.confidence),
          unmeasured ? String(unmeasured.notMeasuredReason ?? "") : `${needs.length} KPI(s)`,
        ]);
      }
    }
  }
  return {
    kind: "table",
    heading: "Needs by Domain, Sub-domain and Indicator",
    columns: ["Classification", "Level", "Severity", "Confidence", "Notes"],
    rows,
  };
}

function patternAnalysisSections(pa: Record<string, unknown>): DocSection[] {
  const out: DocSection[] = [];
  // The caveat leads, then the findings follow — it qualifies the numbers below
  // rather than replacing them. A section that prints only this sentence reads
  // as "no analysis was run", which was never what it meant.
  if (typeof pa.evidenceNote === "string" && pa.evidenceNote) {
    out.push({ kind: "note", heading: "Pattern & Intersection Analysis", text: pa.evidenceNote });
  }
  if (isObjectArray(pa.patterns)) {
    out.push(
      pickTableSection("Observed Patterns", pa.patterns, [
        { key: "pattern", label: "Pattern" },
        { key: "scopeLabel", label: "Scope" },
        { key: "strength", label: "Strength" },
      ]),
    );
  }
  if (isObjectArray(pa.intersections)) {
    out.push(
      pickTableSection("Intersections (equity)", pa.intersections, [
        { key: "finding", label: "Finding" },
        { key: "affectedGroup", label: "Most disadvantaged" },
        { key: "equityFlag", label: "Equity flag" },
      ]),
    );
  }
  // `observedIntersections` and `gaps` are still computed and still travel in
  // the JSON payload — they are deliberately not rendered in the document. The
  // sub-threshold group severities were too easy to quote as an equity finding,
  // and the coverage gaps repeat the domain coverage table in Section 2.
  return out;
}

function priorityNeedsSections(pn: Record<string, unknown>, drillable = false, ns = ""): DocSection[] {
  const out: DocSection[] = [];
  const vp = isPlainObject(pn.villagePriority) ? pn.villagePriority : null;

  if (vp) {
    out.push({
      kind: "keyvalue",
      heading: "Village Priority",
      rows: [
        {
          label: "Priority Score",
          value: vp.priorityScore === null ? "— (not calculable)" : scalar(vp.priorityScore, "priorityScore"),
        },
        { label: "Priority Status", value: scalar(vp.priorityStatus) },
        ...(vp.notCalculableReason ? [{ label: "Why", value: String(vp.notCalculableReason) }] : []),
        { label: "Score direction", value: String(vp.scoreDirectionNote ?? "") },
        { label: "Coverage basis", value: String(vp.coverageBasis ?? "") },
        ...(vp.overrideApplied ? [{ label: "Override", value: String(vp.overrideReason ?? "") }] : []),
      ],
    });
  }
  if (isObjectArray(pn.needs)) {
    out.push(
      pickTableSection(
        "Priority Needs",
        pn.needs,
        [
          { key: "rank", label: "#" },
          ...NEED_RECORD_COLS_FULL,
          { key: "relevanceScore", label: "Relevance" },
        ],
        // Each ranked need drills to its indicator's leaf page — the question
        // wording, response distribution and severity calculation behind the
        // number. That is the client's "click a priority need, see how it was
        // scored" requirement.
        drillable ? pn.needs.map((need) => indicatorAnchor(need.indicatorId, ns)) : undefined,
      ),
    );
  }
  // Ranked out, but never dropped — an indicator nobody could answer is a
  // finding about the assessment, not an absence of need.
  if (isObjectArray(pn.notMeasured)) {
    out.push(pickTableSection("Not Measured (excluded from ranking)", pn.notMeasured, NOT_MEASURED_NEED_COLS));
  }
  return out;
}

function dataQualitySections(dq: Record<string, unknown>): DocSection[] {
  const out: DocSection[] = [];
  const rq = isPlainObject(dq.responseQuality) ? dq.responseQuality : {};
  const conf = isPlainObject(dq.confidence) ? dq.confidence : {};

  out.push({
    kind: "stats",
    heading: "Data Quality Notes",
    tiles: [
      { label: "Submitted", value: String(n(rq.submitted)) },
      { label: "Valid", value: String(n(rq.valid)), sub: `${n(rq.validResponseRatePct)}% of submitted` },
      { label: "Excluded", value: String(n(rq.excluded)) },
      { label: "Don't-know rate", value: `${n(rq.dontKnowRatePct)}%`, sub: scalar(rq.dontKnowBand) },
      { label: "Confidence", value: scalar(conf.flag), sub: `sample ${n(conf.sampleSize)} / ${n(conf.sampleThreshold)}` },
      { label: "Not measured", value: String(n(dq.notMeasuredCount)) },
      { label: "Duplicates flagged", value: String(n(rq.duplicatesFlagged)) },
      { label: "Low-confidence responses", value: String(n(rq.lowConfidenceFlagged)) },
    ],
  });
  if (typeof dq.narrative === "string" && dq.narrative) {
    out.push({ kind: "note", heading: "Data Quality Summary", text: dq.narrative });
  }
  // The survey-level cycle-over-cycle sentence (deriveTrendNote, scope "this
  // survey"). Kept as its own note rather than folded into the narrative above,
  // matching how the two are composed — so a cycle claim and a data-quality
  // claim can never be edited into contradicting each other.
  if (typeof dq.trendNote === "string" && dq.trendNote) {
    out.push({ kind: "note", heading: "Trend", text: dq.trendNote });
  }
  if (isObjectArray(dq.exclusionBreakdown)) {
    out.push(
      pickTableSection("Answer Status Breakdown", dq.exclusionBreakdown, [
        { key: "status", label: "Status" },
        { key: "count", label: "Answers" },
        { key: "sharePct", label: "% of answers" },
      ]),
    );
  }
  if (isObjectArray(dq.notMeasured)) {
    out.push(
      pickTableSection("Indicators With No Measurable Response", dq.notMeasured, [
        { key: "indicatorName", label: "Indicator" },
        { key: "domain", label: "Domain" },
        { key: "reason", label: "Reason" },
      ]),
    );
  }
  if (Array.isArray(dq.domainsNotAssessed) && dq.domainsNotAssessed.length) {
    out.push({ kind: "list", heading: "Domains Not Assessed", items: dq.domainsNotAssessed.map(String) });
  }
  return out;
}

// Sections that carry real weight — a chart or a table — earn their own page.
// A one-line note or a short key/value block does not: a report where every
// paragraph is its own page reads as padded, not as navigable.
const HEAVY_KINDS = new Set(["table", "bars", "pie", "radar", "gauge", "stats", "groupedBars"]);

function isHeavy(s: DocSection): boolean {
  if (s.kind === "columns") return s.children.some(isHeavy);
  return HEAVY_KINDS.has(s.kind);
}

/** Short, honest descriptor for a chapter box — what the reader will find. */
function chapterSummary(sections: DocSection[]): string {
  let rows = 0;
  let charts = 0;
  const walk = (list: DocSection[]) => {
    for (const s of list) {
      if (s.kind === "columns") walk(s.children);
      else if (s.kind === "table") rows += s.rows.length;
      else if (HEAVY_KINDS.has(s.kind)) charts += 1;
    }
  };
  walk(sections);
  const parts: string[] = [];
  if (rows) parts.push(`${rows} row${rows === 1 ? "" : "s"}`);
  if (charts) parts.push(`${charts} chart${charts === 1 ? "" : "s"}`);
  return parts.join(" · ") || "Summary";
}

/**
 * The chapter scheme every report is laid out against.
 *
 * Chapters are SEMANTIC, not "one per heading": a bar chart and the table that
 * restates it belong on the same page, and a box called "Domain Severity
 * (0-100)" tells a reader less than one called "Severity by Domain". Matching
 * is by keyword so a new section heading lands somewhere sensible without this
 * list having to be updated in lockstep.
 *
 * Order here is the order the document reads in — fixed, so the six report
 * types are navigated the same way rather than each in the order its generator
 * happened to push sections.
 */
const CHAPTER_SCHEME: Array<{ name: string; match: RegExp }> = [
  { name: "Overview", match: /report basis|^survey$|coverage|geographic scope|region \/ governorate|portfolio|response quality|needs index|organisation dashboard/i },
  { name: "Executive Summary", match: /executive summary|ai summary|key findings|summary of needs|critical needs/i },
  { name: "Severity by Domain", match: /domain severity|domain profile|^domains$|scoring distribution|collective kpis/i },
  // `domain masking` and `geographic masking` are deliberately distinct: the
  // same no-masking rule applies to domains and to geography, and each alert
  // belongs beside the table it is about, not both in whichever chapter is
  // listed first.
  { name: "Priority Needs", match: /priority tier|domain rollup|domain masking|priority needs|village priority|^priority$|top kpis|top priorities|not measured|priority ranking/i },
  { name: "Geographic Breakdown", match: /^regions$|governorate|^villages$|region scope|geographic masking|village breakdown/i },
  { name: "Methodology Hierarchy", match: /needs by domain|calculation basis|all need records/i },
  { name: "Pattern Analysis", match: /pattern|intersection/i },
  { name: "Demographics", match: /gender|rural|urban|demographic/i },
  { name: "Evidence", match: /evidence|document register|themes across/i },
  { name: "Comparison", match: /comparison|reconciliation/i },
  { name: "Data Quality", match: /data quality|completeness|confidence by domain|flagged records|answer status|anomalies|response funnel|questions per domain/i },
  { name: "Sharing", match: /sharing|^requests$/i },
  { name: "Conclusions & Recommendations", match: /recommendation|reviewer notes|^trend|trend note/i },
];

const FALLBACK_CHAPTER = "Additional Detail";

function chapterFor(section: DocSection): string {
  // A `columns` pair is a layout device with no heading of its own. Classify it
  // by what it CONTAINS, or the severity radar and its bar chart get filed under
  // whatever chapter happened to be open — which is how the domain charts ended
  // up separated from the domain table they illustrate.
  if (section.kind === "columns") {
    for (const child of section.children) {
      const name = chapterFor(child);
      if (name) return name;
    }
    return "";
  }
  const heading = "heading" in section ? (section.heading ?? "") : "";
  if (!heading) return "";
  return CHAPTER_SCHEME.find((c) => c.match.test(heading))?.name ?? FALLBACK_CHAPTER;
}

/**
 * Group a flat section list into the semantic chapters above.
 *
 * A section with no heading (a `columns` pair, an anchor) attaches to whichever
 * chapter is in progress — those are layout devices, not topics of their own.
 */
function chapterize(sections: DocSection[]): Array<{ name: string; sections: DocSection[] }> {
  const order = [...CHAPTER_SCHEME.map((c) => c.name), FALLBACK_CHAPTER];
  const byName = new Map<string, DocSection[]>();
  let current = "";

  for (const section of sections) {
    const name = chapterFor(section) || current || "Overview";
    current = name;
    const list = byName.get(name);
    if (list) list.push(section);
    else byName.set(name, [section]);
  }

  return order
    .filter((name) => byName.has(name))
    .map((name) => ({ name, sections: byName.get(name)! }));
}

/**
 * A report as a navigable document rather than one long scroll.
 *
 * Page 1 is a grid of boxes — one per chapter, named and summarised. Clicking a
 * box opens that chapter's own page; every chapter links back. This mirrors the
 * reference artefact: the interactivity is built from PDF link annotations, so
 * it survives being exported, shared and opened offline.
 */
export function buildReportDoc(
  title: string,
  content: Record<string, unknown>,
  audit: Array<{ label: string; value: string }>,
): ReportDoc {
  const { headerBand, sections: body, drillSections } = buildReportSections(content);
  const chapters = chapterize(body);

  // One chapter (or none) is not worth a contents page — a box grid listing a
  // single entry is furniture, not navigation.
  if (chapters.length < 2) {
    return { title, headerBand, sections: [...body, ...drillSections], audit };
  }

  const docChapters: DocChapter[] = chapters.map((c) => ({
    name: c.name,
    summary: chapterSummary(c.sections),
    sections: c.sections,
  }));

  // The domain drill-down is a destination in its own right, so it becomes a
  // chapter like any other rather than being reachable only by scrolling past
  // everything else.
  if (drillSections.length) {
    docChapters.push({
      name: "Drill-down by Domain",
      summary: "Domain to indicator detail",
      sections: drillSections,
    });
  }

  // `sections` keeps the whole report in reading order. The PDF renderer uses
  // `chapters` to lay them out as collapsible layers; Excel and the on-screen
  // viewer consume `sections` and are unaffected by the chapter split.
  return {
    title,
    headerBand,
    sections: docChapters.flatMap((c) => c.sections),
    audit,
    chapters: docChapters,
  };
}



/**
 * One report's header band and body sections, with every drill anchor prefixed
 * by `reportKey`.
 *
 * Split out of buildReportDoc so the combined export can lay several reports
 * into ONE document without their anchor ids colliding — see nsOf.
 */
function buildReportSections(
  content: Record<string, unknown>,
  reportKey?: string,
): {
  headerBand: Array<{ label: string; value: string }>;
  sections: DocSection[];
  drillSections: DocSection[];
} {
  const ns = nsOf(reportKey);
  // Drill pages are kept apart from the body: they already carry their own
  // page structure, so the chapter pass below must not try to re-chapter them.
  const drillSections: DocSection[] = [];
  const headerBand = isPlainObject(content.header) ? kvRows(content.header) : [];
  // KEEP IN SYNC with the identical predicate in the frontend viewer
  // (Project-RIO-Frontend/src/components/features/reports/report-content-view.tsx).
  // If the two drift, a report renders rich in one place and as a flat key/value
  // dump in the other. `coverage`/`dashboard` are the survey-scoped reports
  // (RPT01/RPT15) — they always carry `severity` too, but listing them here
  // makes the intent explicit rather than incidental.
  // Must stay in step with the `isCore` predicate in report-content-view.tsx —
  // when the two disagree, a report renders as a structured document on screen
  // and as the flat key-value fallback in the export.
  //
  // `evidenceSection` / `geography` are why RPT17 exported as a single "Summary"
  // blob: an evidence-only report has no severity, coverage, dashboard, domains
  // or topPriorities, so it failed every arm of this test and skipped the whole
  // core branch — geography, the documents and Response Quality included.
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
      isObjectArray(content.requests) ||
      isPlainObject(content.evidenceSection) ||
      // RPT03/RPT09 Top-Priority and RPT10 Data-Quality. Neither carries a
      // `severity` block (they project the unified pipeline rather than
      // re-deriving it), so without these two arms both would have fallen
      // through to the flat key-value dump — the same defect RPT17 hit.
      isObjectArray(content.tierSummary) ||
      isObjectArray(content.completeness) ||
      isPlainObject(content.geography));

  const sections: DocSection[] = [];

  if (isCore) {
    // Section 0 — what this report rests on. Renders first so the SURVEY-ONLY /
    // QUANTITATIVE basis is established before any number is read.
    if (isPlainObject(content.reportMeta)) sections.push(reportBasisSection(content.reportMeta));

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
          { label: "Assessment Cycle", value: scalar(sv.assessmentCycle) },
          { label: "Assessment Period", value: scalar(sv.assessmentPeriod) },
          { label: "Methodology Version", value: scalar(sv.methodologyVersion) },
        ],
      });
    }

    // Coverage / portfolio count bands — the volume context for everything
    // that follows.
    const surveyOnly =
      isPlainObject(content.reportMeta) && content.reportMeta.sourceBasis === "SURVEY_ONLY";
    if (isPlainObject(content.coverage)) sections.push(coverageStats(content.coverage, surveyOnly));
    if (isPlainObject(content.unitGeo)) {
      const g = content.unitGeo as Record<string, unknown>;
      sections.push({
        kind: "keyvalue",
        heading: "Geographic Scope",
        rows: [
          { label: "Scope", value: scalar(g.scopeLabel) },
          { label: "Region", value: scalar(g.regionName) },
          { label: "Governorate(s)", value: (g.governorateNames as string[])?.join(", ") || "—" },
          { label: "Village(s)", value: (g.villages as string[])?.join(", ") || "—" },
        ],
      });
    }
    if (isPlainObject(content.portfolio)) sections.push(portfolioStats(content.portfolio));

    // ── Section 2 — Executive Summary ──
    if (isPlainObject(content.executiveSummary)) {
      sections.push(...executiveSummarySections(content.executiveSummary));
    }

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

    // ── RPT03/RPT09 Top-Priority headline: tier distribution, then the domain
    // rollup carrying the no-masking columns. Both come before the ranked list
    // so a reader meets the shape of the findings before the findings. ──
    if (isObjectArray(content.tierSummary)) {
      const maxCount = Math.max(1, ...content.tierSummary.map((r) => Number(r.count) || 0));
      sections.push(barsSection("Needs by Priority Tier", content.tierSummary, "tier", "count", maxCount));
      sections.push(pickTableSection("Priority Tier Summary", content.tierSummary, TIER_SUMMARY_COLS));
    }
    if (isObjectArray(content.domainRollup)) {
      sections.push(pickTableSection("Domain Rollup", content.domainRollup, DOMAIN_ROLLUP_COLS));
      // The no-masking rule made explicit. A reader who only skims the averages
      // column is precisely the reader this note exists for.
      const masking = content.domainRollup.filter((r) => r.masksCriticalFinding === true);
      if (masking.length) {
        sections.push({
          kind: "note",
          heading: "Domain Masking Alert",
          text:
            `${masking.length} domain(s) average a milder band than their worst KPI: ` +
            `${masking.map((r) => scalar(r.domain)).join(", ")}. ` +
            "Per the methodology, a critical need surfaces regardless of its domain average — " +
            "read the Max KPI Severity column, not the average, for these domains.",
        });
      }
    }

    // ── RPT10 Data-Quality: completeness tiles, per-domain confidence, then
    // the flagged records themselves. ──
    if (isObjectArray(content.completeness)) {
      sections.push({
        kind: "keyvalue",
        heading: "Completeness & Confidence",
        rows: content.completeness.map((r) => ({ label: scalar(r.label), value: scalar(r.value) })),
      });
    }
    if (isObjectArray(content.domainConfidence)) {
      sections.push(pickTableSection("Confidence by Domain", content.domainConfidence, DOMAIN_CONFIDENCE_COLS));
    }
    // Array.isArray, NOT isObjectArray — an EMPTY flagged list must still print
    // its section. isObjectArray is false for `[]`, which would have dropped the
    // section entirely, and a missing section reads as "quality was not checked"
    // rather than "nothing was flagged". Under AC 6 those are opposite claims.
    if (Array.isArray(content.flaggedRecords)) {
      sections.push({
        kind: "note",
        heading: "Flagged Records",
        text:
          content.flaggedRecords.length === 0
            ? "No incomplete or unassessed records were found. Every indicator in scope produced a measurable score."
            : `${content.flaggedRecords.length} record(s) are flagged below. They are listed rather than removed — ` +
              "each remains part of the dataset and is excluded only from severity averages, where noted.",
      });
      if (content.flaggedRecords.length) {
        sections.push(pickTableSection("Flagged Records Detail", content.flaggedRecords, FLAGGED_RECORD_COLS));
      }
    }

    // The evidence (RPT15) and combined (RPT16) reports carry structured
    // `geography` rather than the executive report's `scope`. Without this the
    // required Region → Governorate section was silently absent from every
    // exported PDF and spreadsheet.
    if (isPlainObject(content.geography)) {
      const geo = content.geography as Record<string, unknown>;
      // The viewer plots `geo.regions` on the Kingdom map; a PDF has no map, so
      // the same figures are carried as a row rather than being lost with it.
      const plotted = isObjectArray(geo.regions) ? geo.regions : [];
      const unit = Array.isArray(geo.mapUnitLabel) ? scalar(geo.mapUnitLabel[1]) : "records";
      const rows = [
        { label: "Region", value: scalar(geo.region) },
        { label: "Governorate", value: scalar(geo.governorate) },
        ...(geo.center !== undefined ? [{ label: "Center", value: scalar(geo.center) }] : []),
        ...(plotted.length
          ? [
              {
                label: "Mapped coverage",
                value: plotted
                  .map((r) => `${scalar(r.name)} (${scalar(r.count)} ${unit})`)
                  .join("; "),
              },
            ]
          : []),
      ];
      sections.push({ kind: "keyvalue", heading: "Region / Governorate", rows });
    }

    // The domain → sub-domain → indicator hierarchy is what the drill pages are
    // built from. No hierarchy → no drill targets, and every table stays plain
    // rather than offering a click that leads nowhere.
    const hierarchy = isObjectArray(content.needsByDomain) ? content.needsByDomain : null;
    const drillable = hierarchy !== null;

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
      // Each domain row drills into its own detail page when the hierarchy that
      // backs those pages is present. `domainCode` here and `domainKey` in the
      // hierarchy are the same methodology key under two field names.
      domainsTable = pickTableSection(
        "Domains",
        domains,
        DOMAIN_TABLE_COLS,
        drillable ? domains.map((d) => domainAnchor(d.domainCode, ns)) : undefined,
      );
    }

    // Row 1: gauge + response quality (or whichever exists).
    // The dial needs ~a third; Response Quality carries a full sentence
    // ("Why this band") and needs the rest, or it wraps four lines deep beside
    // an empty half-page.
    if (gauge && rq) sections.push({ kind: "columns", children: [gauge, rq], weights: [1, 2] });
    else if (gauge) sections.push(gauge);
    else if (rq) sections.push(rq);

    // Row 2: radar + severity bars.
    if (radar && bars) sections.push({ kind: "columns", children: [radar, bars] });
    else if (bars) sections.push(bars);
    if (domainsTable) sections.push(domainsTable);


    // ── Section 3 — the full methodology hierarchy ──
    if (isObjectArray(content.needsByDomain)) {
      sections.push(needsByDomainSection(content.needsByDomain));
    }

    // ── Section 4 — Pattern & Intersection Analysis ──
    if (isPlainObject(content.patternAnalysis)) {
      sections.push(...patternAnalysisSections(content.patternAnalysis));
    }

    // ── Section 5 — Priority Needs. Supersedes the flat Priority block below
    // when present, so the two never render the same figure twice. ──
    if (isPlainObject(content.priorityNeeds)) {
      sections.push(...priorityNeedsSections(content.priorityNeeds, drillable, ns));
    } else if (isPlainObject(content.priority)) {
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
        if (slaGauge) sections.push({ kind: "columns", children: [slaGauge, kpiRows], weights: [1, 2] });
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
    // ── RPT06 Region: scope band, governorate rows, then the villages
    // beneath them. The scope band comes first so a reader knows what the rows
    // cover before reading them — including what could NOT be attributed. ──
    if (isPlainObject(content.regionScope)) {
      const rs = content.regionScope as Record<string, unknown>;
      const unscored = Array.isArray(rs.unscoredVillages) ? (rs.unscoredVillages as unknown[]) : [];
      sections.push({
        kind: "keyvalue",
        heading: "Region Scope",
        rows: [
          { label: "Region", value: scalar(rs.regionName) },
          { label: "Governorates covered", value: scalar(rs.governorateCount) },
          { label: "Villages covered", value: scalar(rs.villageCount) },
          // Both of these are findings about the assessment, not omissions:
          // stating them is what stops a partial region reading as a complete one.
          { label: "Needs with no governorate link", value: scalar(rs.unmappedNeedCount) },
          {
            label: "Villages not yet scored",
            value: unscored.length ? unscored.map(String).join(", ") : "None",
          },
          { label: "How severity is aggregated", value: scalar(rs.aggregationBasis) },
        ],
      });
    }
    if (isObjectArray(content.regions)) {
      sections.push(pickTableSection("Governorates", content.regions, GOVERNORATE_COLS));
      const masking = content.regions.filter(
        (r) =>
          typeof r.severityScore === "number" &&
          typeof r.maxVillageSeverity === "number" &&
          severityBandOf(r.maxVillageSeverity) !== severityBandOf(r.severityScore),
      );
      if (masking.length) {
        sections.push({
          kind: "note",
          heading: "Geographic Masking Alert",
          text:
            `${masking.length} governorate(s) average a milder band than their worst village: ` +
            `${masking.map((r) => scalar(r.governorate)).join(", ")}. ` +
            "Read the Worst Village column, not the average, for these rows.",
        });
      }
    }
    if (isObjectArray(content.villages)) {
      sections.push(pickTableSection("Villages", content.villages, REGION_VILLAGE_COLS));
    }
    if (isObjectArray(content.topKpis)) sections.push(pickTableSection("Top KPIs", content.topKpis, TOP_KPI_COLS));
    if (isObjectArray(content.topPriorities)) sections.push(tableSection("Top Priorities", content.topPriorities));

    // Demographics. The Executive report may have an empty topPriorities list,
    // so also treat a report carrying Response Quality as a needs report —
    // otherwise it would silently drop the demographics placeholder that every
    // other needs report shows.
    const isNeedsReport =
      !!sev ||
      !!domains ||
      isObjectArray(content.regions) ||
      isObjectArray(content.topPriorities) ||
      isPlainObject(content.responseQuality);
    const demo = isPlainObject(content.demographics) ? content.demographics : null;
    const toSlices = (arr: Array<Record<string, unknown>>) => arr.map((r) => ({ label: scalar(r.label), value: Number(r.count) || 0 }));
    // Gender is the headline demographic finding, so it is drawn large and
    // centred on its own full width rather than squeezed beside the settlement
    // split. The two were paired to keep the report short; now that
    // Demographics is its own chapter that constraint is gone.
    const genderPie: DocSection | null =
      demo && isObjectArray(demo.gender)
        ? { kind: "pie", heading: "Gender Breakdown", slices: toSlices(demo.gender), emphasis: true }
        : null;
    const ruralPie: DocSection | null =
      demo && isObjectArray(demo.rural) ? { kind: "pie", heading: "Rural / Urban Breakdown", slices: toSlices(demo.rural) } : null;
    if (genderPie) sections.push(genderPie);
    if (ruralPie) sections.push(ruralPie);
    if (!genderPie && !ruralPie && isNeedsReport) sections.push(DEMOGRAPHICS_NOTE);


    if (isPlainObject(content.aiSummary)) sections.push(...aiSummarySections(content.aiSummary));

    // ── Section 6 — Data Quality Notes. MANDATORY: rendered whenever the block
    // exists, even when every sub-field is empty. ──
    if (isPlainObject(content.dataQualityNotes)) {
      sections.push(...dataQualitySections(content.dataQualityNotes));
    }
    // Every need record, flat — the machine-readable payload, also readable.
    if (isObjectArray(content.needRecords)) {
      sections.push(pickTableSection("All Need Records", content.needRecords, NEED_RECORD_COLS_FULL));
    }

    // First-class Data Quality and Trend notes (promoted out of the AI Summary,
    // currently the region report) — rendered as their own labeled sections.
    // Suppressed when the structured Section 6 above is present, so the same
    // note never appears twice.
    if (
      !isPlainObject(content.dataQualityNotes) &&
      typeof content.dataQualityNote === "string" &&
      content.dataQualityNote
    ) {
      sections.push({ kind: "note", heading: "Data Quality Note", text: content.dataQualityNote });
    }
    // Suppressed only when Section 6 actually printed a trend note — a report
    // that carries `dataQualityNotes` without one must still show this.
    const section6Trend =
      isPlainObject(content.dataQualityNotes) &&
      typeof content.dataQualityNotes.trendNote === "string" &&
      content.dataQualityNotes.trendNote;
    if (!section6Trend && typeof content.trendNote === "string" && content.trendNote) {
      sections.push({ kind: "note", heading: "Trend Note", text: content.trendNote });
    }
    if (Array.isArray(content.anomalies) && content.anomalies.length) {
      sections.push({ kind: "list", heading: "Anomalies Flagged", items: content.anomalies.map(String) });
    }
    if (content.reviewerNotes) {
      sections.push({ kind: "note", heading: "Reviewer Notes", text: String(content.reviewerNotes) });
    }

    // ── Evidence and combined-summary sections (RPT15 / RPT16) ──
    // These were previously absent from every export: the core branch never
    // looked at them, so the uploaded documents, their AI summaries and the
    // whole combined narrative existed in the stored report but not in the PDF
    // or spreadsheet a reviewer actually receives.
    if (isPlainObject(content.evidenceSection)) {
      sections.push(...evidenceSections(content.evidenceSection));
    }
    if (isPlainObject(content.scoreSummarySection)) {
      sections.push(...scoreSummarySections(content.scoreSummarySection));
    }
    if (isPlainObject(content.combinedSummarySection)) {
      sections.push(...combinedSummarySections(content.combinedSummarySection));
    }

    // ── Drill-down pages ──
    //
    // Appended LAST so the report still reads top-to-bottom as a document for
    // anyone who never clicks: summary first, detail behind it. The index grid
    // carries its own anchor so every detail page can link back to it.
    if (hierarchy) {
      drillSections.push({ kind: "anchor", id: drillIndexAnchor(ns) });
      drillSections.push(...drillDownSections(hierarchy, ns));
    }

    // Top-level recommendations. `aiSummarySections` handles the nested
    // `aiSummary.recommendations`, which is a different field.
    if (Array.isArray(content.recommendations) && content.recommendations.length) {
      sections.push({
        kind: "list",
        heading: "Recommendations",
        items: content.recommendations.map((r) =>
          isPlainObject(r) ? scalar((r as Record<string, unknown>).intervention) : String(r),
        ),
      });
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

  return { headerBand, sections, drillSections };
}
