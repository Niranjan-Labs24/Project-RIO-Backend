import {
  ACCENT,
  BLACK,
  BOTTOM,
  CONTENT_W,
  GRAY,
  LEFT,
  LIGHT,
  PAGE_H,
  Pdf,
  heading,
  renderSection,
  textWidth,
  TOP,
  truncate,
  wrap,
} from '../reports/pdf-builder';
import type {
  NcnpMonthlyPoint,
  NcnpOrgNeedingAttention,
  NcnpReport,
  NcnpVillageScorecard,
} from './ncnp-report.types';

// A dedicated, page-aware PDF layout for the NCNP Consolidated Report — unlike
// every other report type (which flows through the generic, page-agnostic
// buildReportDoc/renderReportPdf pair), this report has a real 6-page
// structure the client asked for explicitly, matching the live UI's
// ReportPageShell (masthead on page 1, running header + footer disclaimer on
// every page, page badges, numbered sections, donut charts with a center
// total, colored status badges, and the app's actual --chart-1..5 palette
// rather than a generic rainbow). That doesn't fit the generic renderer's
// "flow sections until they run out, plain solid pies, one fixed bright
// color" model, so this builds its own page loop and its own donut/bar/
// trend/badge/KPI-card drawing — while still reusing pdf-builder.ts's
// lower-level primitives (Pdf class, its pie/disc/rect/text ops) rather than
// a second full renderer.
//
// Content is capped to the same "top 5 / Showing N of Total" lists the UI
// uses, so each page's content is expected to fit one physical Letter page.
// If a given dataset ever produces more content than that (Pdf.ensure()
// auto-inserts an extra physical page when something overflows), the footer
// on that forced extra page repeats the same page label rather than
// incrementing it — an accepted edge case, not a silent data loss.

const TOTAL_PAGES = 6;
const REPORT_NAME = 'NCNP Compiled Report';
const DISCLAIMER = 'This report contains aggregated metrics only. Detailed records are available within the NCNP application.';

// Top N by count, with a "Showing N of Total" disclosure below (same
// pattern as every other capped list in this report — org summary, top
// orgs by responses, etc). A real platform can easily have 15-20+ distinct
// governorates/centers with linked data, which doesn't fit on one page
// alongside the map, region bars, and org health at readable size — capping
// with disclosure keeps the page count sane without silently hiding data
// (the true total is always shown). Regions are a small, fixed set (13 real
// KSA regions, max) — never worth capping on their own.
const GEO_CHART_LIMIT = 10;
const REGION_CHART_LIMIT = 20;
function capBreakdown<T>(items: T[], limit = GEO_CHART_LIMIT): { shown: T[]; total: number; truncated: boolean } {
  return { shown: items.slice(0, limit), total: items.length, truncated: items.length > limit };
}

// The app's actual chart/status palette (src/styles/tokens.css), converted
// from OKLCH to sRGB (0-1 per channel, PDF fill-color format) — NOT the
// generic bright rainbow pdf-builder.ts's PIE_COLORS uses for other report
// types. Bars use --chart-1 (NamedBarList's bg-chart-1); donuts use the same
// --chart-N sequence the UI's StatusDonut assigns per segment; badges use
// --destructive/--warning/--chart-2, matching the UI's Badge variants.
const CHART_1 = '0.49 0.61 0.64'; // steel blue-gray — bars, single-series charts
const CHART_2 = '0.52 0.66 0.58'; // sage green — "positive"/second series
const CHART_3 = '0.30 0.50 0.66'; // ocean blue
const CHART_4 = '0.19 0.59 0.32'; // forest green
const DESTRUCTIVE = '0.91 0.00 0.04';
const WARNING = '0.86 0.64 0.00';
const WHITE = '1 1 1';

// A validated 7-hue categorical set (CVD-safe adjacent pairs) — used for any
// breakdown where distinct series need to read apart at a glance (Age
// Distribution's up to 7 slices, Gender Distribution's 2-4). The app's
// --chart-1..5 tokens (CHART_1..5 above) are tuned for single-series
// bars/status badges, not adjacent-category distinctness — CHART_1/CHART_2
// in particular are close enough in hue/lightness to be hard to tell apart.
const AGE_BRACKET_COLORS = [
  '0.16 0.47 0.84', // blue
  '0.92 0.41 0.20', // orange
  '0.11 0.69 0.48', // aqua
  '0.93 0.63 0.00', // yellow
  '0.91 0.48 0.64', // magenta
  '0.00 0.51 0.00', // green
  '0.29 0.23 0.65', // violet
];

// Display order matches the Prisma AgeBracket enum's declaration order.
const AGE_BRACKET_LABELS: Record<string, string> = {
  age_15_24: '15–24',
  age_25_34: '25–34',
  age_35_44: '35–44',
  age_45_54: '45–54',
  age_55_64: '55–64',
  age_65_plus: '65+',
  prefer_not_to_say: 'Prefer not to say',
};

// Matches the Prisma Gender enum's values.
const GENDER_LABELS: Record<string, string> = {
  male: 'Male',
  female: 'Female',
  other: 'Other',
  prefer_not_to_say: 'Prefer not to say',
};
const AGE_BRACKET_ORDER = ['age_15_24', 'age_25_34', 'age_35_44', 'age_45_54', 'age_55_64', 'age_65_plus', 'prefer_not_to_say'];

// Matches the Prisma NeedSource enum's values, in the client's own Report
// Type terminology (Survey / Uploaded Document / ...) rather than the raw
// enum identifiers — 'manual_entry' is a Need entered directly through a
// form, i.e. the same "Survey" provenance the client's report-type naming
// uses (see docs/ncnp-unified-need-record-schema-analysis.md's source_type
// analysis). 'citizen_input'/'field_survey' have no producing code path yet
// (see Need.source's own schema comment), kept here anyway so an unexpected
// value never falls through to the raw enum identifier.
const NEED_SOURCE_LABELS: Record<string, string> = {
  manual_entry: 'Survey',
  file_upload: 'Uploaded Document',
  citizen_input: 'Citizen Input',
  field_survey: 'Field Survey',
};

// Matches the Prisma RejectionReasonCode enum's identifiers — UNSPECIFIED
// covers surveys rejected before this field existed (see
// NcnpReportService.buildSurveyAnalytics).
const REJECTION_REASON_LABELS: Record<string, string> = {
  REJ_01: 'Incomplete survey design',
  REJ_02: 'Methodology non-compliance',
  REJ_03: 'Duplicate of an existing survey',
  REJ_04: 'Incorrect need or study linkage',
  REJ_05: 'Out-of-scope geography or target population',
  REJ_06: 'Data quality concerns',
  REJ_07: 'Missing required attachments or approvals',
  REJ_99: 'Other',
  UNSPECIFIED: 'Unspecified (legacy)',
};

// Status/priority badge palette — light tint backgrounds paired with the
// matching dark foreground, mirroring the UI's Badge component variants.
const GREEN_BG = '0.87 0.95 0.90';
const RED_BG = '0.98 0.90 0.90';
const AMBER_BG = '0.99 0.94 0.83';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function reportId(generatedAt: string): string {
  const d = new Date(generatedAt);
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `NCNP-${stamp}`;
}

function pageLabel(page: number): string {
  return `Page ${page} of ${TOTAL_PAGES}`;
}

// Running header repeated at the top of pages 2-6 — report name + condensed
// scope on the left, the page badge on the right (mirrors ReportPageShell's
// default runhead in the live UI; page 1 gets the fuller masthead instead).
function drawRunhead(pdf: Pdf, condensedScope: string, page: number): void {
  pdf.y = TOP - 10;
  const label = `${REPORT_NAME.toUpperCase()} — ${condensedScope.toUpperCase()}`;
  pdf.text(LEFT, 8, false, truncate(label, 8, CONTENT_W - 90), GRAY);
  const b = pageLabel(page);
  pdf.text(LEFT + CONTENT_W - textWidth(b, 8), 8, true, b, ACCENT);
  pdf.y += 13;
  pdf.rule(GRAY, 0.5);
  pdf.y += 8;
}

// Footer disclaimer + page badge, pinned to the bottom margin band on every
// page (mirrors ReportPageShell's footer). Drawn last so it always lands at
// a fixed position regardless of how much content preceded it on the page.
function drawFooter(pdf: Pdf, page: number): void {
  pdf.y = PAGE_H - BOTTOM + 8;
  pdf.rule(GRAY, 0.4);
  pdf.y += 7;
  const label = pageLabel(page);
  pdf.text(LEFT, 7.5, false, truncate(DISCLAIMER, 7.5, CONTENT_W - 70), GRAY);
  pdf.text(LEFT + CONTENT_W - textWidth(label, 7.5), 7.5, false, label, GRAY);
}

// A thin card frame around the full page content area — mirrors
// ReportPageShell's bordered card in the live UI. Drawn once, independent of
// how much content the page ends up holding.
function drawPageFrame(pdf: Pdf): void {
  const savedY = pdf.y;
  pdf.y = TOP - 18;
  pdf.strokeRect(LEFT - 10, CONTENT_W + 20, PAGE_H - BOTTOM - TOP + 30, '0.85 0.85 0.87', 0.75);
  pdf.y = savedY;
}

// The true, once-per-page report title (e.g. "Public Survey Overview") —
// mirrors the live UI's PageHeading (serif, largest on the page, generous
// space around it). Previously every heading level in this file — the page
// title, the numbered mid-level sections, and individual chart/table titles
// — called pdf-builder's single shared `heading()`, so all three read as the
// same size/weight/color with nothing to tell them apart. This is the top
// of that hierarchy; sectionHeading is the middle tier; chartTitle is the
// bottom tier for anything below a numbered section.
function pageTitle(pdf: Pdf, text: string): void {
  pdf.ensure(34);
  pdf.y += 6;
  pdf.text(pdf.rx, 18, true, text, BLACK, 'serif');
  pdf.y += 26;
}

// Section heading with the same "01  Title" numbering as the live UI's
// SectionLabel — a sequence carries real information here (each page's
// sections are presented in this fixed reading order), so it isn't just
// decoration.
function sectionHeading(pdf: Pdf, num: number, title: string): void {
  heading(pdf, `${String(num).padStart(2, '0')}   ${title}`);
}

// A chart/table's own title (e.g. "Studies Created — Last 12 Months",
// "Organizations Needing Attention") — the bottom tier, subordinate to the
// numbered section it sits inside. Deliberately smaller, unaccented, and
// without a rule line so it doesn't compete with sectionHeading above it.
function chartTitle(pdf: Pdf, text: string): void {
  pdf.ensure(15);
  pdf.text(pdf.rx, 9, true, text, BLACK);
  pdf.y += 15;
}

// Dark-to-light steel-blue ramp — when `graduated` is set, the largest bar
// (assumed first/rank 0, since every list here is server-sorted descending)
// gets the darkest shade and each smaller bar gets progressively lighter, so
// magnitude reads through color as well as length. Without this, Region/
// Governorate/Center all rendered in the exact same flat CHART_1, which is
// why they "seemed the same" at a glance.
const BAR_DARK = [0.07, 0.22, 0.42];
const BAR_LIGHT = [0.68, 0.85, 0.93];
function barShade(i: number, n: number): string {
  const t = n > 1 ? i / (n - 1) : 0;
  return BAR_DARK.map((d, k) => (d + (BAR_LIGHT[k]! - d) * t).toFixed(2)).join(' ');
}

// A horizontal bar list — same layout as pdf-builder's generic renderBars,
// but using the app's actual --chart-1 (NamedBarList's bg-chart-1) instead
// of pdf-builder's fixed bright BAR color. Kept local rather than changed
// globally, since other report types' bars weren't designed against this
// token and shouldn't change without their own review.
function renderBarsChart(
  pdf: Pdf,
  title: string,
  max: number,
  bars: Array<{ label: string; value: number }>,
  opts?: { color?: string; graduated?: boolean },
): void {
  if (title) chartTitle(pdf, title);
  if (bars.length === 0) {
    pdf.text(pdf.rx + 2, 8.5, false, 'No data available yet.', GRAY);
    pdf.y += 14;
    return;
  }
  const graduated = opts?.graduated ?? false;
  const flatColor = opts?.color ?? CHART_1;
  const labelW = Math.min(140, pdf.rw * 0.4);
  const trackX = pdf.rx + labelW;
  const trackW = pdf.rw - labelW - 36;
  bars.forEach(({ label, value }, i) => {
    pdf.ensure(22);
    const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    const color = graduated ? barShade(i, bars.length) : flatColor;
    pdf.text(pdf.rx + 2, 9.5, false, truncate(label, 9.5, labelW - 8));
    pdf.rect(trackX, trackW, 13, LIGHT);
    if (frac > 0) pdf.rect(trackX, Math.max(1, trackW * frac), 13, color);
    pdf.text(trackX + trackW + 6, 9.5, true, String(value));
    pdf.y += 18;
  });
}

// A bar list for labels too long to survive renderBarsChart's fixed-width
// side column without truncating (e.g. "Out-of-scope geography or target
// population") — the label gets its own full-width line(s) above the bar
// instead of being squeezed into a ~40%-width column and cut off with "..".
// Used for the Rejection Reason Breakdown specifically; every other bar list
// in this report has short enough labels (region/org/domain names) that
// renderBarsChart's layout still reads fine.
function renderLabeledBarsChart(
  pdf: Pdf,
  title: string,
  max: number,
  bars: Array<{ label: string; value: number }>,
): void {
  if (title) chartTitle(pdf, title);
  if (bars.length === 0) {
    pdf.text(pdf.rx + 2, 8.5, false, 'No data available yet.', GRAY);
    pdf.y += 14;
    return;
  }
  const valueColW = 36;
  const trackW = pdf.rw - valueColW;
  bars.forEach(({ label, value }, i) => {
    const lines = wrap(label, 9, pdf.rw);
    pdf.ensure(lines.length * 11 + 14);
    lines.forEach((line) => {
      pdf.text(pdf.rx, 9, false, line, BLACK);
      pdf.y += 11;
    });
    pdf.y += 1;
    const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    pdf.rect(pdf.rx, trackW, 12, LIGHT);
    if (frac > 0) pdf.rect(pdf.rx, Math.max(1, trackW * frac), 12, barShade(i, bars.length));
    pdf.text(pdf.rx + trackW + 6, 9, true, String(value));
    pdf.y += 15;
  });
}

// A vertical column chart (bars rising from a shared baseline, value above,
// category label below) — used for Organizations by Governorate so Page 2's
// three geographic breakdowns are visually distinct shapes (horizontal /
// vertical / horizontal), not three identical-looking progress bars.
// A number under each bar (1, 2, 3…) instead of the category name — full
// governorate/center names under narrow columns either wrapped or ran into
// each other. A compact numbered legend underneath maps each number back to
// its name and value, same trade a legend already makes for a pie/donut.
// Above this many columns a column chart stops being readable at page width
// (bars and their number labels start colliding) — fall back to the
// horizontal bar layout instead, which just grows downward and can show any
// count without hiding data.
const MAX_COLUMNS = 12;

function renderColumnChart(pdf: Pdf, title: string, max: number, bars: Array<{ label: string; value: number }>): void {
  if (bars.length > MAX_COLUMNS) {
    renderBarsChart(pdf, title, max, bars, { graduated: true });
    return;
  }
  if (title) chartTitle(pdf, title);
  if (bars.length === 0) {
    pdf.text(pdf.rx + 2, 8.5, false, 'No data available yet.', GRAY);
    pdf.y += 14;
    return;
  }
  const plotH = 60;
  const labelPad = 11;
  pdf.ensure(plotH + labelPad + 20);
  pdf.y += labelPad;
  const top = pdf.y;
  const n = bars.length;
  const gap = 10;
  const colW = (pdf.rw - gap * (n - 1)) / n;
  const barW = Math.min(36, colW * 0.6);
  bars.forEach((b, i) => {
    const x = pdf.rx + i * (colW + gap) + (colW - barW) / 2;
    const frac = max > 0 ? Math.max(0, Math.min(1, b.value / max)) : 0;
    const barH = Math.max(2, frac * plotH);
    pdf.y = top + (plotH - barH);
    pdf.rect(x, barW, barH, barShade(i, n));
    const valStr = String(b.value);
    pdf.y = top + (plotH - barH) - 11;
    pdf.text(x + barW / 2 - textWidth(valStr, 8.5) / 2, 8.5, true, valStr);
  });
  pdf.y = top + plotH;
  pdf.rule(GRAY, 0.5);
  pdf.y += 4;
  bars.forEach((b, i) => {
    const x = pdf.rx + i * (colW + gap) + (colW - barW) / 2;
    const num = String(i + 1);
    pdf.text(x + barW / 2 - textWidth(num, 7.5) / 2, 7.5, true, num, GRAY);
  });
  pdf.y = top + plotH + 10;

  // Column count must respond to the actual space available, not just item
  // count — this chart is often used inside a half-width column (paired
  // with another chart), where 4 columns of a fixed rule left almost no
  // room per label and truncated real governorate/center names down to a
  // handful of characters. A minimum per-column width keeps labels legible
  // regardless of whether the chart is rendered full- or half-width.
  const minLegColW = 105;
  const legCols = Math.max(1, Math.min(Math.floor(pdf.rw / minLegColW), n));
  const legRows = Math.ceil(n / legCols);
  const legColW = pdf.rw / legCols;
  const legRowH = 12;
  const legTop = pdf.y;
  bars.forEach((b, i) => {
    const row = i % legRows;
    const col = Math.floor(i / legRows);
    const x = pdf.rx + col * legColW;
    pdf.y = legTop + row * legRowH;
    pdf.rect(x, 7, 7, barShade(i, n));
    const txt = `${i + 1}   ${b.label} — ${b.value.toLocaleString()}`;
    pdf.text(x + 10, 7, false, truncate(txt, 7, legColW - 14), GRAY);
  });
  pdf.y = legTop + legRows * legRowH + 6;
}

// A real line chart (polyline + point markers), matching the live UI's
// TrendLineChart — pdf-builder.ts has no line-chart primitive at all (only
// bars/pie/gauge/radar), so month-over-month trends were wrongly rendered as
// bars in the first pass. A single data point degrades to a centered dot +
// label (same reasoning as TrendLineChart's own single-point branch: a
// 1-coordinate line has no slope to draw).
// A real area chart — filled area under the line, a labeled Y-axis
// (max/mid/0) and an X-axis baseline with month labels — matching the live
// UI's TrendLineChart intent, not a bare line or (for one data point) a
// floating dot with no axis at all. A single data point still gets a real
// axis and a value dropped onto it, rather than a special-cased empty look.
// A minimal inline trend beside a headline KPI number — no axes/gridlines,
// just enough shape to read as "this is the recent trend." Distinct from
// renderTrendLine, which is a full annotated chart in its own section.
function renderSparkline(pdf: Pdf, x: number, topY: number, w: number, h: number, values: number[]): void {
  if (values.length < 2) return;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const stepX = w / (values.length - 1);
  const coords: Array<[number, number]> = values.map((v, i) => [x + i * stepX, topY + h - ((v - min) / range) * h]);
  pdf.strokePath(coords, CHART_1, 1.2);
  const last = coords[coords.length - 1]!;
  pdf.disc(last[0], last[1], 2, CHART_1);
}

function renderTrendLine(pdf: Pdf, title: string, points: NcnpMonthlyPoint[]): void {
  if (title) chartTitle(pdf, title);
  const h = 95;
  // A value label can sit directly above the highest point (when a point is
  // at 100% of the chart's max), so the plot area needs headroom below the
  // heading — without it, that label collides with the heading text itself.
  const topPad = 18;
  pdf.ensure(h + topPad + 30);
  pdf.y += topPad;
  const top = pdf.y;
  const plotX = pdf.rx;
  const w = pdf.rw;
  if (points.length === 0) {
    pdf.text(pdf.rx + 2, 8.5, false, 'No data available yet.', GRAY);
    pdf.y = top + 16;
    return;
  }
  const max = Math.max(1, ...points.map((p) => p.count));
  // A faint mid reference line + solid baseline — structure without
  // cluttering the chart with numeric tick labels (matches the live UI's
  // TrendLineChart, which uses the same restrained gridline treatment).
  pdf.strokePath([[plotX, top + h / 2], [plotX + w, top + h / 2]], '0.90 0.90 0.91', 0.5);
  pdf.strokePath([[plotX, top + h], [plotX + w, top + h]], '0.75 0.76 0.78', 0.8);

  if (points.length === 1) {
    const x = plotX + w / 2;
    const y = top + h - (points[0]!.count / max) * h;
    pdf.strokePath([[x, top + h], [x, y]], CHART_1, 1.5);
    pdf.disc(x, y, 4.5, CHART_1);
    const valStr = points[0]!.count.toLocaleString();
    pdf.y = y - 16;
    pdf.text(x - textWidth(valStr, 10) / 2, 10, true, valStr, ACCENT);
    pdf.y = top + h + 10;
    pdf.text(x - textWidth(points[0]!.month, 7.5) / 2, 7.5, false, points[0]!.month, GRAY);
    pdf.y = top + h + 24;
    return;
  }
  const stepX = w / (points.length - 1);
  const coords: Array<[number, number]> = points.map((p, i) => [plotX + i * stepX, top + h - (p.count / max) * h]);
  pdf.fillPolygon([[plotX, top + h], ...coords, [plotX + w, top + h]], '0.87 0.90 0.92');
  pdf.strokePath(coords, CHART_1, 2);
  const lastIdx = coords.length - 1;
  coords.forEach(([x, y], i) => {
    pdf.y = y;
    if (i === lastIdx) {
      pdf.disc(x, y, 5, '1 1 1');
      pdf.disc(x, y, 3.5, ACCENT);
      const valStr = points[i]!.count.toLocaleString();
      pdf.y = y - 16;
      pdf.text(Math.min(x, plotX + w - textWidth(valStr, 9)), 9, true, valStr, ACCENT);
    } else {
      pdf.disc(x, y, 2.4, CHART_1);
    }
  });
  pdf.y = top + h + 10;
  const labelCount = Math.min(5, points.length);
  const showIdx = Array.from(new Set(
    Array.from({ length: labelCount }, (_, i) => Math.round((i / (labelCount - 1)) * (points.length - 1))),
  ));
  showIdx.forEach((idx) => {
    const p = points[idx]!;
    const [x] = coords[idx]!;
    pdf.text(x - textWidth(p.month, 7) / 2, 7, false, p.month, GRAY);
  });
  pdf.y = top + h + 24;
}

// A thin, single-row two-segment bar with a legend below — a donut/pie is
// the wrong chart for a two-category, heavily skewed split (e.g. Study
// Status's typical 96%/4% Active/Archived); this reads the split faster.
function renderTwoStateBar(
  pdf: Pdf,
  title: string,
  primaryLabel: string,
  primaryCount: number,
  secondaryLabel: string,
  secondaryCount: number,
): void {
  if (title) chartTitle(pdf, title);
  const total = primaryCount + secondaryCount || 1;
  const primaryPct = (primaryCount / total) * 100;
  const secondaryPct = 100 - primaryPct;
  const barH = 20;
  pdf.ensure(barH + 34);
  const barTop = pdf.y;
  const primaryW = Math.max(1, pdf.rw * (primaryPct / 100));
  const secondaryW = Math.max(1, pdf.rw * (secondaryPct / 100));
  pdf.rect(pdf.rx, pdf.rw, barH, LIGHT);
  if (primaryCount > 0) pdf.rect(pdf.rx, primaryW, barH, CHART_2);
  if (secondaryCount > 0) {
    pdf.rect(pdf.rx + pdf.rw * (primaryPct / 100), secondaryW, barH, CHART_1);
  }
  // A solid single-color bar (the common case when one side is 0%, e.g.
  // Study Status's Active/Archived) otherwise reads as an unlabeled color
  // swatch — printing the count/percentage directly on the segment (when
  // it's wide enough to hold the text) makes the bar self-explanatory
  // without requiring the legend below to be read first.
  const segmentTextY = barTop + barH / 2 - 8.5 * 0.76 * 0.5;
  if (primaryCount > 0) {
    const label = `${primaryCount.toLocaleString()} · ${primaryPct.toFixed(0)}%`;
    const tw = textWidth(label, 8.5);
    if (tw + 12 <= primaryW) {
      pdf.y = segmentTextY;
      pdf.text(pdf.rx + primaryW / 2 - tw / 2, 8.5, true, label, WHITE);
    }
  }
  if (secondaryCount > 0) {
    const label = `${secondaryCount.toLocaleString()} · ${secondaryPct.toFixed(0)}%`;
    const tw = textWidth(label, 8.5);
    const segX = pdf.rx + pdf.rw * (primaryPct / 100);
    if (tw + 12 <= secondaryW) {
      pdf.y = segmentTextY;
      pdf.text(segX + secondaryW / 2 - tw / 2, 8.5, true, label, WHITE);
    }
  }
  pdf.y = barTop + barH + 12;
  pdf.rect(pdf.rx, 9, 9, CHART_2);
  pdf.text(
    pdf.rx + 13,
    9,
    false,
    `${primaryLabel}   ${primaryCount.toLocaleString()} · ${primaryPct.toFixed(0)}%`,
  );
  const secondX = pdf.rx + pdf.rw / 2;
  pdf.rect(secondX, 9, 9, CHART_1);
  pdf.text(
    secondX + 13,
    9,
    false,
    `${secondaryLabel}   ${secondaryCount.toLocaleString()} · ${secondaryPct.toFixed(0)}%`,
  );
  pdf.y += 22;
}

// A plain filled pie (no center cutout) — a distinct chart shape from
// renderDonut, offered so not every breakdown in this report is the same
// ring shape. Same real --chart-N colors passed in per call, not
// pdf-builder's generic bright rainbow.
function renderPieChart(pdf: Pdf, title: string, slices: Array<{ label: string; value: number; color: string }>): void {
  if (title) chartTitle(pdf, title);
  const r = 44;
  pdf.ensure(2 * r + 12);
  const top = pdf.y;
  const total = slices.reduce((s, d) => s + d.value, 0) || 1;
  pdf.pie(
    pdf.rx,
    r,
    slices.map((s) => s.value),
    slices.map((s) => s.color),
  );
  const legX = pdf.rx + 2 * r + 18;
  pdf.y = top + 3;
  slices.forEach((s) => {
    const pct = Math.round((s.value / total) * 100);
    pdf.rect(legX, 7, 7, s.color);
    pdf.text(legX + 12, 8.5, false, truncate(`${s.label}: ${s.value.toLocaleString()} (${pct}%)`, 8.5, pdf.rx + pdf.rw - legX - 14));
    pdf.y += 13;
  });
  pdf.y = Math.max(top + 2 * r + 8, pdf.y);
}

// A real donut (ring, not a solid pie) with the total centered inside —
// matches the live UI's StatusDonut exactly, unlike pdf-builder's generic
// renderPie (a solid filled pie with a side legend, drawn in a fixed bright
// rainbow unrelated to --chart-1..5). Colors are passed in per call so each
// chart can match the exact --chart-N/semantic color the UI assigns that
// segment (e.g. Draft is chart-3, not "whichever color is first").
function renderDonut(
  pdf: Pdf,
  headingNum: number | null,
  headingText: string,
  centerLabel: string,
  slices: Array<{ label: string; value: number; color: string }>,
): void {
  if (headingNum !== null) sectionHeading(pdf, headingNum, headingText);
  const r = 50;
  pdf.ensure(2 * r + 14);
  const top = pdf.y;
  const total = slices.reduce((s, d) => s + d.value, 0) || 1;
  pdf.pie(
    pdf.rx,
    r,
    slices.map((s) => s.value),
    slices.map((s) => s.color),
  );
  const cx = pdf.rx + r;
  const cyc = top + r;
  pdf.disc(cx, cyc, r * 0.6, '1 1 1');
  const totalStr = total.toLocaleString();
  pdf.y = cyc - 9;
  pdf.text(cx - textWidth(totalStr, 19) / 2, 19, true, totalStr);
  pdf.y = cyc + 8;
  const lbl = truncate(centerLabel.toUpperCase(), 6.5, 2 * r - 12);
  pdf.text(cx - textWidth(lbl, 6.5) / 2, 6.5, false, lbl, GRAY);
  const legX = pdf.rx + 2 * r + 20;
  pdf.y = top + 8;
  slices.forEach((s) => {
    const pct = Math.round((s.value / total) * 100);
    pdf.rect(legX, 8, 8, s.color);
    pdf.y += 0.5;
    pdf.text(legX + 13, 9, false, truncate(`${s.label}   ${s.value.toLocaleString()} · ${pct}%`, 9, pdf.rx + pdf.rw - legX - 15));
    pdf.y += 17.5;
  });
  pdf.y = Math.max(top + 2 * r + 10, pdf.y);
}

// A rounded-look status pill (rect — this renderer has no arc primitive for
// true rounded corners, but a small solid tag reads the same as the UI's
// Badge at this scale).
function badge(pdf: Pdf, x: number, label: string, bg: string, fg: string): number {
  const size = 7.5;
  const padX = 5;
  const w = textWidth(label, size) + padX * 2;
  const h = 12;
  const savedY = pdf.y;
  pdf.rect(x, w, h, bg);
  pdf.y = savedY + 2.3;
  pdf.text(x + padX, size, true, label, fg);
  pdf.y = savedY;
  return w;
}

// A gray caption line that actually wraps within the current column width —
// a single non-wrapping pdf.text() call let long captions run past the
// column's right edge into the neighboring column.
function renderCaption(pdf: Pdf, text: string): void {
  const lines = wrap(text, 8.5, pdf.rw);
  const top = pdf.y;
  lines.forEach((ln, i) => {
    pdf.y = top + i * 11;
    pdf.text(pdf.rx, 8.5, false, ln, GRAY);
  });
  pdf.y = top + lines.length * 11 + 4;
}

// "Showing N of Total" italic note — same truncation-disclosure pattern the
// UI uses under every capped list/table (e.g. Organization Summary).
function renderShowingOf(pdf: Pdf, shown: number, total: number): void {
  pdf.ensure(13);
  pdf.text(pdf.rx, 7.5, false, `Top ${shown} of ${total}`, GRAY);
  pdf.y += 13;
}

// A light-gray horizontal strip with equal-width columns (small caption
// above, bold value below) — mirrors the wireframe's Scope row (Reporting
// Period / Region / Generated On / Generated By side by side), replacing a
// vertically-stacked key/value list.
function renderScopeRow(pdf: Pdf, items: Array<{ label: string; value: string }>): void {
  const h = 34;
  pdf.ensure(h + 6);
  const top = pdf.y;
  pdf.rect(pdf.rx, pdf.rw, h, LIGHT);
  const w = pdf.rw / items.length;
  items.forEach((item, i) => {
    const x = pdf.rx + i * w;
    pdf.y = top + 8;
    pdf.text(x + 8, 7, true, item.label.toUpperCase(), GRAY);
    pdf.y = top + 21;
    pdf.text(x + 8, 9.5, true, truncate(item.value, 9.5, w - 14));
  });
  pdf.y = top + h + 8;
}

// Bordered KPI tiles (big number + label) — mirrors the UI's Page 1 stat
// tiles, replacing a plain key/value list with the same "card" visual.
// Wraps into multiple rows of `perRow` tiles when there are more than fit
// legibly in one row on a Letter-width page (e.g. 7 platform-summary tiles).
function renderKpiTiles(pdf: Pdf, tiles: Array<{ label: string; value: string | number }>, perRow = tiles.length): void {
  const gap = 8;
  const rows: Array<Array<{ label: string; value: string | number }>> = [];
  for (let i = 0; i < tiles.length; i += perRow) rows.push(tiles.slice(i, i + perRow));
  const w = (pdf.rw - gap * (perRow - 1)) / perRow;
  const h = 36;
  for (const row of rows) {
    pdf.ensure(h + 8);
    const top = pdf.y;
    row.forEach((t, i) => {
      const x = pdf.rx + i * (w + gap);
      pdf.y = top;
      pdf.rect(x, w, h, LIGHT);
      pdf.y = top;
      pdf.strokeRect(x, w, h, '0.83 0.86 0.90', 0.75);
      const valStr = typeof t.value === 'number' ? t.value.toLocaleString() : t.value;
      pdf.y = top + 7;
      pdf.text(x + 7, 16, true, truncate(valStr, 16, w - 12), ACCENT);
      pdf.y = top + h - 14;
      pdf.text(x + 7, 7.5, false, truncate(t.label, 7.5, w - 12), GRAY);
    });
    pdf.y = top + h + 7;
  }
}

function pct1(stat: { current: number; changePct: number | null }): string {
  return stat.changePct === null ? `${stat.current} (new)` : `${stat.current} (${stat.changePct > 0 ? '+' : ''}${stat.changePct.toFixed(1)}%)`;
}

function priorityBadgeColors(status: string): [string, string] {
  if (status === 'HIGH') return [RED_BG, DESTRUCTIVE];
  if (status === 'MEDIUM') return [AMBER_BG, WARNING];
  return [GREEN_BG, CHART_4];
}

// Organization Summary table with a colored Active/Inactive status badge —
// the generic renderTable only draws plain text cells, so this table (the
// one place on the page that needs a colored cell) is hand-drawn.
// Organizations with no recent activity — a genuinely different cut from
// the Organization Summary table below (which is a top-N-by-response
// leaderboard, the same handful of names repeated across Pages 2/3/5). This
// is the one place on the report that surfaces orgs a monitoring body would
// actually want to follow up on.
function renderNeedsAttention(pdf: Pdf, rows: NcnpOrgNeedingAttention[], activeOrgCount: number): void {
  // A real progress read (Healthy vs Flagged, out of active orgs) rather
  // than a flat, undifferentiated color bar — the flat green fill carried
  // no data at all when the count was 0 (looked identical to any other
  // decorative bar); this always plots the true proportion, including the
  // all-healthy case.
  const flagged = rows.length;
  const healthy = Math.max(0, activeOrgCount - flagged);
  renderTwoStateBar(pdf, 'Organizations Needing Attention', 'Healthy', healthy, 'Flagged', flagged);
  if (rows.length === 0) {
    pdf.text(pdf.rx + 2, 8.5, false, 'Every active organization has recent activity.', GRAY);
    pdf.y += 14;
    return;
  }
  pdf.y += 4;
  for (const r of rows.slice(0, 5)) {
    pdf.ensure(14.5);
    pdf.text(pdf.rx + 2, 8.5, false, truncate(r.organizationName, 8.5, pdf.rw * 0.62));
    const dateStr = r.lastActivity ? fmtDate(r.lastActivity) : 'No recorded activity';
    pdf.text(pdf.rx + pdf.rw - textWidth(dateStr, 7.5), 7.5, false, dateStr, GRAY);
    pdf.y += 14.5;
  }
}

// Highest-Priority Villages table with a colored HIGH/MEDIUM/LOW badge.
function renderVillageTable(pdf: Pdf, rows: NcnpVillageScorecard[]): void {
  const widths = [pdf.rw * 0.42, pdf.rw * 0.3, pdf.rw * 0.28];
  const xs: number[] = [];
  let cursor = pdf.rx;
  for (const w of widths) {
    xs.push(cursor);
    cursor += w;
  }
  const headerH = 17;
  pdf.ensure(headerH + rows.length * 17 + 4);
  pdf.rect(pdf.rx, pdf.rw, headerH, LIGHT);
  const headerTop = pdf.y;
  pdf.y = headerTop + 5;
  pdf.text(xs[0]! + 3, 8, true, 'Village');
  const scoreHdr = 'Priority Score';
  pdf.text(xs[1]! + widths[1]! - 4 - textWidth(scoreHdr, 8), 8, true, scoreHdr);
  pdf.text(xs[2]! + 3, 8, true, 'Status');
  pdf.y = headerTop + headerH;
  pdf.rule(GRAY, 0.5);
  pdf.y += 2;
  for (const v of rows) {
    const rowH = 17;
    pdf.ensure(rowH + 2);
    const top = pdf.y;
    pdf.text(xs[0]! + 3, 8.5, false, truncate(v.villageId, 8.5, widths[0]! - 6));
    const scoreStr = v.priorityScore.toFixed(1);
    pdf.text(xs[1]! + widths[1]! - 4 - textWidth(scoreStr, 8.5), 8.5, false, scoreStr);
    pdf.y = top;
    const [bg, fg] = priorityBadgeColors(v.priorityStatus);
    badge(pdf, xs[2]! + 3, v.priorityStatus, bg, fg);
    pdf.y = top + rowH;
  }
}

// Same simplified KSA outline + internal division lines as the live UI's
// LeafletMapContainer (leaflet-map.tsx) — real boundary coordinates, kept in
// sync with that file rather than a second invented shape. [lng, lat] pairs
// (GeoJSON order), not [lat, lng].
const KSA_OUTLINE: Array<[number, number]> = [
  [34.5, 28.5],
  [36.0, 29.5],
  [38.0, 31.5],
  [39.0, 32.0],
  [42.0, 31.0],
  [44.5, 33.3],
  [47.5, 30.0],
  [48.5, 29.8],
  [48.5, 28.5],
  [50.5, 26.5],
  [51.5, 26.0],
  [50.8, 24.5],
  [51.5, 23.0],
  [55.5, 22.5],
  [55.0, 20.0],
  [53.0, 19.0],
  [52.0, 19.0],
  [47.0, 16.5],
  [43.0, 16.5],
  [42.6, 16.3],
  [42.5, 17.5],
  [41.5, 18.5],
  [40.0, 20.0],
  [39.5, 21.5],
  [39.0, 23.0],
  [37.5, 25.0],
  [36.5, 27.5],
  [34.5, 28.5],
];
const KSA_INTERNAL_BORDERS: Array<Array<[number, number]>> = [
  [[45.0, 29.0], [45.5, 26.5], [46.5, 24.0], [47.5, 21.0], [48.0, 19.5]],
  [[43.5, 27.5], [44.5, 25.5], [45.5, 24.5]],
  [[38.5, 24.0], [40.0, 23.5], [41.5, 23.0]],
  [[41.0, 19.0], [42.5, 18.0], [44.0, 17.5]],
  [[36.5, 29.5], [38.5, 29.8], [41.0, 30.5]],
  [[41.0, 26.0], [42.5, 25.5], [43.5, 25.0]],
  [[47.0, 20.0], [49.0, 20.5], [51.0, 21.5]],
  [[39.5, 21.5], [41.0, 20.0], [42.0, 19.0]],
];
// Real GPS coordinates for KSA's 13 regions — same source as the UI's
// RegionMap (KSA_Geographic_Reference_EN.xlsx has no lat/lng for
// governorates, only region-level, hence region-level here too).
const KSA_REGION_COORDS: Record<string, { lat: number; lng: number }> = {
  Riyadh: { lat: 24.7136, lng: 46.6753 },
  'Makkah Al-Mukarramah': { lat: 21.3891, lng: 39.8579 },
  'Madinah Al-Munawwarah': { lat: 24.5247, lng: 39.5692 },
  'Al-Qassim': { lat: 26.326, lng: 43.975 },
  'Eastern Province': { lat: 26.4207, lng: 50.0888 },
  Aseer: { lat: 18.2164, lng: 42.5053 },
  Tabuk: { lat: 28.3835, lng: 36.5662 },
  Hail: { lat: 27.5219, lng: 41.6961 },
  'Northern Borders': { lat: 30.9753, lng: 41.0381 },
  Jazan: { lat: 16.8894, lng: 42.5511 },
  Najran: { lat: 17.4924, lng: 44.1277 },
  'Al-Baha': { lat: 20.0129, lng: 41.4676 },
  'Al-Jouf': { lat: 29.9697, lng: 40.2064 },
};

// A real vector-drawn kingdom map (not a raster/screenshot) — the outline
// and region coordinates are the exact same real data the live UI's Leaflet
// map uses, projected with a simple cos(lat)-corrected equirectangular
// projection (fine for a small inset map at this scale). Region-level only,
// same constraint as the UI: no GPS coordinates exist for individual
// governorates in the platform's reference data, so plotting at that level
// would mean fabricating coordinates.
function renderKingdomMap(pdf: Pdf, regionCounts: Array<{ name: string; count: number }>): void {
  const w = pdf.rw;
  const h = 150;
  pdf.ensure(h + 10);
  const top = pdf.y;
  const lngs = KSA_OUTLINE.map((p) => p[0]);
  const lats = KSA_OUTLINE.map((p) => p[1]);
  const lngMin = Math.min(...lngs);
  const lngMax = Math.max(...lngs);
  const latMin = Math.min(...lats);
  const latMax = Math.max(...lats);
  const aspect = Math.cos(((latMin + latMax) / 2) * (Math.PI / 180));
  const lngSpan = (lngMax - lngMin) * aspect;
  const latSpan = latMax - latMin;
  const pad = 14;
  const scale = Math.min((w - 2 * pad) / lngSpan, (h - 2 * pad) / latSpan);
  const offsetX = pdf.rx + (w - lngSpan * scale) / 2;
  const offsetY = top + (h - latSpan * scale) / 2;
  const project = ([lng, lat]: [number, number]): [number, number] => [
    offsetX + (lng - lngMin) * aspect * scale,
    offsetY + (latMax - lat) * scale,
  ];

  pdf.fillPolygon(KSA_OUTLINE.map(project), '0.93 0.94 0.95');
  pdf.strokePath(KSA_OUTLINE.map(project), '0.30 0.34 0.38', 1.2, true);
  for (const line of KSA_INTERNAL_BORDERS) {
    pdf.strokePath(line.map(project), '0.55 0.58 0.62', 0.6);
  }

  // Area-proportional (sqrt of count), not linear — linear radius scaling
  // exaggerates the gap between the largest and smallest regions, which
  // made adjacent regions' circles (several real KSA regions sit close
  // together on a small-scale map — Riyadh/Qassim/Eastern Province/Makkah/
  // Madinah in particular) collide into an unreadable cluster. A per-marker
  // name label made this worse (13 text labels competing for the same
  // crowded space) — dropped here; the "Organizations by Region" bar list
  // directly below gives the exact name-to-count mapping instead, same
  // pattern as the numbered legends used elsewhere in this report.
  const maxCount = Math.max(1, ...regionCounts.map((r) => r.count));
  const markers = regionCounts
    .map((r) => {
      const coord = KSA_REGION_COORDS[r.name];
      if (!coord || r.count <= 0) return null;
      const [x, y] = project([coord.lng, coord.lat]);
      const radius = 6 + Math.sqrt(r.count / maxCount) * 9;
      return { x, y, radius, count: r.count };
    })
    .filter((m): m is { x: number; y: number; radius: number; count: number } => m !== null);

  // Several real KSA regions (Riyadh/Qassim/Eastern Province/Makkah/
  // Madinah) sit close enough together that their true geographic
  // coordinates put same-scale circles on top of each other — a simple
  // pairwise "dodge" pass nudges overlapping circles apart along the line
  // between their centers until they clear, same technique proportional-
  // symbol maps use, rather than drawing them literally on top of each
  // other and calling it a map.
  const markerPad = 1.5;
  for (let iter = 0; iter < 40; iter++) {
    let moved = false;
    for (let i = 0; i < markers.length; i++) {
      for (let j = i + 1; j < markers.length; j++) {
        const a = markers[i]!;
        const b = markers[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const minDist = a.radius + b.radius + markerPad;
        if (dist < minDist) {
          const push = (minDist - dist) / 2;
          const ux = dx / dist;
          const uy = dy / dist;
          a.x -= ux * push;
          a.y -= uy * push;
          b.x += ux * push;
          b.y += uy * push;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  for (const m of markers) {
    pdf.disc(m.x, m.y, m.radius, CHART_3);
    pdf.disc(m.x, m.y, m.radius * 0.6, '1 1 1');
    const valStr = String(m.count);
    const valSize = m.radius >= 9 ? 8 : 6.5;
    pdf.y = m.y - valSize * 0.38;
    pdf.text(m.x - textWidth(valStr, valSize) / 2, valSize, true, valStr, CHART_3);
  }
  pdf.y = top + h + 8;
}

export function renderNcnpReportPdf(report: NcnpReport, generatedByName: string): Buffer {
  const {
    summary,
    orgHealth,
    orgSummary,
    needDomains,
    needSubDomains,
    needsGeography,
    studyStatus,
    publicLinkStatus,
    studyOverview,
    geography,
    surveyAnalytics,
    surveyGeography,
    regionSummary,
    responseAnalytics,
    priorityOverview,
    criticalNeeds,
    dataQualityNotes,
    domainRegionIntersections,
  } = report;

  const condensedScope = `Last ${summary.newThisPeriod.periodDays} days · All Regions`;
  // Semantic status colors (Draft=neutral, Submitted=amber/in-review,
  // Published=green/good, Rejected=red/critical), matching the UI's
  // StatusDonut exactly — the generic chart-1..5 rotation these used before
  // made every status read as "visually equal," with nothing to tell a
  // healthy Published share from a concerning Rejected one at a glance.
  const surveyStatusSlices = [
    { label: 'Draft', value: surveyAnalytics.statusPlatformWide.draft, color: GRAY },
    { label: 'Submitted', value: surveyAnalytics.statusPlatformWide.submitted, color: WARNING },
    { label: 'Published', value: surveyAnalytics.statusPlatformWide.published, color: CHART_4 },
    { label: 'Rejected', value: surveyAnalytics.statusPlatformWide.rejected, color: DESTRUCTIVE },
  ];
  const pdf = new Pdf();

  // ---- Page 1 — Executive Summary (masthead instead of the running header) ----
  drawPageFrame(pdf);
  pdf.y = TOP;
  pdf.text(LEFT, 9, true, 'RIO PLATFORM — NATIONAL COUNCIL FOR NGO PARTNERSHIPS', ACCENT);

  // Page badge + report ID pinned top-right, drawn against the eyebrow
  // line's y rather than the left column's flow below — text() positions
  // off pdf.y, not an offset argument, so each line needs its own y.
  const topRightY = pdf.y;
  const badge1 = pageLabel(1);
  pdf.text(LEFT + CONTENT_W - textWidth(badge1, 8), 8, true, badge1, ACCENT);
  pdf.y = topRightY + 13;
  const ridLabel = `Report ID: ${reportId(report.generatedAt)}`;
  pdf.text(LEFT + CONTENT_W - textWidth(ridLabel, 7.5), 7.5, false, ridLabel, GRAY);
  pdf.y = topRightY;

  pdf.y += 24;
  pdf.text(LEFT, 24, true, REPORT_NAME, BLACK, 'serif');
  pdf.y += 34;
  pdf.text(LEFT, 9.5, false, 'Platform-level consolidation — kingdom-wide needs assessment overview', GRAY);
  pdf.y += 20;
  const descLines = wrap(
    'This report compiles a national, kingdom-wide overview of needs, organizations, studies, public surveys, and responses across the NCNP platform for the selected reporting period. It contains aggregated metrics only — for individual records, review the relevant section inside the application.',
    8.5,
    CONTENT_W,
  );
  const descTop = pdf.y;
  descLines.forEach((ln, i) => {
    pdf.y = descTop + i * 12;
    pdf.text(LEFT, 8.5, false, ln, GRAY);
  });
  pdf.y = descTop + descLines.length * 12 + 16;
  pdf.rule(ACCENT, 1.2);
  pdf.y += 14;

  renderScopeRow(pdf, [
    { label: 'Reporting Period', value: `Last ${summary.newThisPeriod.periodDays} days` },
    { label: 'Region', value: 'All Regions' },
    { label: 'Generated On', value: fmtDate(report.generatedAt) },
    { label: 'Generated By', value: generatedByName },
  ]);
  pdf.y += 10;

  const avgResponsesPerSurvey = summary.totals.surveys > 0 ? summary.totals.responses / summary.totals.surveys : 0;
  sectionHeading(pdf, 1, 'Key Metrics');
  renderKpiTiles(
    pdf,
    [
      { label: 'Organizations', value: summary.totals.organizations },
      { label: 'Studies', value: summary.totals.studies },
      { label: 'Public Surveys', value: summary.totals.surveys },
      { label: 'Total Responses', value: summary.totals.responses },
      { label: 'Total Needs', value: summary.totals.needs },
      { label: 'Open Surveys', value: publicLinkStatus.open },
      { label: 'Closed Surveys', value: publicLinkStatus.closed },
      { label: 'Avg. Responses / Survey', value: avgResponsesPerSurvey.toFixed(1) },
    ],
    4,
  );
  pdf.y += 12;

  sectionHeading(pdf, 2, 'Survey Status & Platform Growth');
  renderDonut(pdf, null, '', 'SURVEYS', surveyStatusSlices);
  pdf.y += 14;

  sectionHeading(pdf, 3, 'New This Period');
  renderCaption(pdf, 'Counted by each record’s own creation/submission date — see Page 5 for the response trend over time');
  renderKpiTiles(
    pdf,
    [
      { label: 'Organizations', value: pct1(summary.newThisPeriod.organizations) },
      { label: 'Studies', value: pct1(summary.newThisPeriod.studies) },
      { label: 'Surveys', value: pct1(summary.newThisPeriod.surveys) },
      { label: 'Responses', value: pct1(summary.newThisPeriod.responses) },
    ],
    4,
  );
  pdf.y += 12;

  sectionHeading(pdf, 4, 'Top Critical Needs');
  if (criticalNeeds.topCriticalNeeds.length === 0) {
    renderCaption(pdf, 'No Needs have a village-priority assessment yet — nothing to rank.');
  } else {
    renderCaption(pdf, `Ranked by priority score — ${criticalNeeds.totalRankableNeeds} of ${criticalNeeds.totalNeeds} Needs have an assessment to rank by.`);
    criticalNeeds.topCriticalNeeds.forEach((n, i) => {
      pdf.ensure(28);
      const rowTop = pdf.y;
      pdf.text(pdf.rx, 9.5, true, `${i + 1}. ${n.needTitle}`, BLACK);
      pdf.y = rowTop + 13;
      const meta = [n.organizationName, n.domain, n.primaryGap ? `Primary gap: ${n.primaryGap}` : null]
        .filter((v): v is string => Boolean(v))
        .join(' · ');
      pdf.text(pdf.rx, 8, false, meta, GRAY);
      const statusLabel = `${n.priorityStatus} · ${n.priorityScore.toFixed(1)}`;
      pdf.y = rowTop;
      pdf.text(pdf.rx + pdf.rw - textWidth(statusLabel, 9), 9, true, statusLabel, n.priorityStatus === 'HIGH' ? DESTRUCTIVE : n.priorityStatus === 'MEDIUM' ? WARNING : CHART_4);
      pdf.y = rowTop + 24;
    });
  }
  drawFooter(pdf, 1);

  // ---- Page 2 — Organization Overview ----
  pdf.newPage();
  drawPageFrame(pdf);
  drawRunhead(pdf, condensedScope, 2);
  pageTitle(pdf, 'Organization Overview');

  sectionHeading(pdf, 1, 'Geographic Distribution');
  renderCaption(pdf, 'Organizations are grouped by Region → Governorate → Center, in decreasing geographic granularity.');
  const byRegion = capBreakdown(geography.organizationsByRegion, REGION_CHART_LIMIT);
  const byGovernorate = capBreakdown(geography.organizationsByGovernorate);
  const byCenter = capBreakdown(geography.organizationsByCenter);

  // Full width and tall enough to actually read as a map, not a half-width
  // thumbnail squeezed beside a bar chart — the region breakdown moves below
  // it instead, still full width, rather than sharing the row.
  pdf.text(pdf.rx, 9, true, 'Organizations Across the Kingdom');
  pdf.y += 12;
  renderCaption(pdf, 'Region-level only — no GPS coordinates for individual governorates.');
  renderKingdomMap(pdf, geography.organizationsByRegion);
  pdf.y += 8;

  renderBarsChart(
    pdf,
    'Organizations by Region',
    Math.max(1, ...byRegion.shown.map((g) => g.count)),
    byRegion.shown.map((g) => ({ label: g.name, value: g.count })),
    { graduated: true },
  );
  if (byRegion.truncated) renderShowingOf(pdf, byRegion.shown.length, byRegion.total);
  pdf.y += 8;

  renderBarsChart(
    pdf,
    'Organizations by Governorate',
    Math.max(1, ...byGovernorate.shown.map((g) => g.count)),
    byGovernorate.shown.map((g) => ({ label: g.name, value: g.count })),
    { graduated: true },
  );
  if (byGovernorate.truncated) renderShowingOf(pdf, byGovernorate.shown.length, byGovernorate.total);
  pdf.y += 8;

  renderBarsChart(
    pdf,
    'Organizations by Center',
    Math.max(1, ...byCenter.shown.map((g) => g.count)),
    byCenter.shown.map((g) => ({ label: g.name, value: g.count })),
    { graduated: true },
  );
  if (byCenter.truncated) renderShowingOf(pdf, byCenter.shown.length, byCenter.total);
  pdf.y += 8;

  sectionHeading(pdf, 2, 'Organization Health');
  renderKpiTiles(pdf, [
    { label: 'Active', value: orgHealth.active },
    { label: 'Inactive', value: orgHealth.inactive },
    { label: `Dormant (${orgHealth.dormantDays}+ days)`, value: orgHealth.dormant },
  ]);
  pdf.y += 8;
  renderNeedsAttention(pdf, orgHealth.needsAttention, orgHealth.active);
  pdf.y += 6;

  sectionHeading(pdf, 3, 'Organization Summary');
  renderCaption(pdf, 'Three separate top-5 rankings — a single list sorted by one metric would hide organizations that lead on the others.');

  // Three columns side by side, not stacked full-width — these three lists
  // used to run one after another down the page, each a full-width block,
  // which took 3x the vertical space of just one list and routinely pushed
  // the last one or two onto an otherwise near-empty new page.
  // renderLabeledBarsChart (label above its bar, full column width) means a
  // long org name still wraps cleanly in a ~1/3-width column instead of
  // truncating the way renderBarsChart's fixed side-label column would.
  const orgSummaryStart = pdf.y;
  const orgSummaryColGap = 12;
  const orgSummaryColW = (pdf.rw - orgSummaryColGap * 2) / 3;
  const orgSummaryHeight = 15 + Math.max(orgSummary.byStudies.length, orgSummary.bySurveys.length, orgSummary.byResponses.length, 1) * 27 + 14 + 8;
  pdf.ensure(orgSummaryHeight);
  const os1 = pdf.column(pdf.rx, orgSummaryColW, orgSummaryStart, () => {
    renderLabeledBarsChart(
      pdf,
      'Top Organizations — by Studies',
      Math.max(1, ...orgSummary.byStudies.map((r) => r.studyCount)),
      orgSummary.byStudies.map((r) => ({ label: r.organizationName, value: r.studyCount })),
    );
    if (orgSummary.byStudies.length > 0) renderShowingOf(pdf, orgSummary.byStudies.length, orgSummary.totalOrganizations);
  });
  const os2 = pdf.column(pdf.rx + orgSummaryColW + orgSummaryColGap, orgSummaryColW, orgSummaryStart, () => {
    renderLabeledBarsChart(
      pdf,
      'Top Organizations — by Surveys',
      Math.max(1, ...orgSummary.bySurveys.map((r) => r.surveyCount)),
      orgSummary.bySurveys.map((r) => ({ label: r.organizationName, value: r.surveyCount })),
    );
    if (orgSummary.bySurveys.length > 0) renderShowingOf(pdf, orgSummary.bySurveys.length, orgSummary.totalOrganizations);
  });
  const os3 = pdf.column(pdf.rx + (orgSummaryColW + orgSummaryColGap) * 2, orgSummaryColW, orgSummaryStart, () => {
    renderLabeledBarsChart(
      pdf,
      'Top Organizations — by Responses',
      Math.max(1, ...orgSummary.byResponses.map((r) => r.responseCount)),
      orgSummary.byResponses.map((r) => ({ label: r.organizationName, value: r.responseCount })),
    );
    if (orgSummary.byResponses.length > 0) renderShowingOf(pdf, orgSummary.byResponses.length, orgSummary.totalOrganizations);
  });
  pdf.y = Math.max(os1, os2, os3);
  drawFooter(pdf, 2);

  // ---- Page 3 — Study Overview ----
  pdf.newPage();
  drawPageFrame(pdf);
  drawRunhead(pdf, condensedScope, 3);
  pageTitle(pdf, 'Study Overview');

  sectionHeading(pdf, 1, 'Need Categories & Study Status');
  renderBarsChart(
    pdf,
    'Need Categories — by Domain',
    Math.max(1, ...needDomains.map((d) => d.needCount)),
    needDomains.map((d) => ({ label: d.domainName, value: d.needCount })),
  );
  pdf.y += 14;
  renderTwoStateBar(pdf, 'Study Status', 'Active', studyStatus.active, 'Archived', studyStatus.archived);
  pdf.y += 16;

  // Studies by Region + Organizations with the Highest Number of Studies
  // side by side, not stacked full-width — both are short (a handful of
  // regions/rows), and stacking them one after another left this page
  // noticeably under-filled once the Needs geography/sub-domain/pattern
  // sections (05-07 below) were added and pushed to a second physical page
  // regardless — pairing these two reclaims roughly one section's worth of
  // height for that content instead of leaving it as blank space here.
  const p3aStart = pdf.y;
  const p3aEnd1 = pdf.column(pdf.rx, pdf.rw / 2 - 8, p3aStart, () => {
    sectionHeading(pdf, 2, 'Studies by Region');
    renderBarsChart(
      pdf,
      '',
      Math.max(1, ...geography.studiesByRegion.map((g) => g.count)),
      geography.studiesByRegion.map((g) => ({ label: g.name, value: g.count })),
    );
  });
  const p3aEnd2 = pdf.column(pdf.rx + pdf.rw / 2 + 8, pdf.rw / 2 - 8, p3aStart, () => {
    // Shortened from "Organizations with the Highest Number of Studies" —
    // that full title truncates unreadably at this column's half-width
    // (heading() truncates to the current column width, not just the full
    // page width). Same section, same data; only the label changes here.
    sectionHeading(pdf, 3, 'Top Orgs by Study Count');
    renderSection(pdf, {
      kind: 'table',
      heading: '',
      columns: ['Organization', 'Studies'],
      rows: studyOverview.topOrgsByStudyCount.map((o) => [o.organizationName, String(o.studyCount)]),
    });
    if (studyOverview.topOrgsByStudyCount.length > 0) {
      renderShowingOf(pdf, studyOverview.topOrgsByStudyCount.length, studyOverview.totalOrganizations);
    }
  });
  pdf.y = Math.max(p3aEnd1, p3aEnd2) + 10;

  sectionHeading(pdf, 4, 'Studies Created — Last 12 Months');
  renderTrendLine(pdf, '', studyOverview.studiesCreatedTrend);
  pdf.y += 10;

  // Kingdom-wide rollup of Needs themselves — distinct from "Organizations
  // by Region" (page 2) and "Survey Distribution by Region" (page 4),
  // which count organizations/surveys, not individual Needs.
  sectionHeading(pdf, 5, 'Needs — Kingdom-Wide Geographic Rollup');
  const needsByRegion = capBreakdown(needsGeography.byRegion, REGION_CHART_LIMIT);
  const needsByGovernorate = capBreakdown(needsGeography.byGovernorate);
  const needsByCenter = capBreakdown(needsGeography.byCenter);
  renderColumnChart(
    pdf,
    'Needs by Region',
    Math.max(1, ...needsByRegion.shown.map((g) => g.count)),
    needsByRegion.shown.map((g) => ({ label: g.name, value: g.count })),
  );
  if (needsByRegion.truncated) renderShowingOf(pdf, needsByRegion.shown.length, needsByRegion.total);
  pdf.y += 4;
  const p3bStart = pdf.y;
  const p3bEnd1 = pdf.column(pdf.rx, pdf.rw / 2 - 8, p3bStart, () => {
    renderBarsChart(
      pdf,
      'Needs by Governorate',
      Math.max(1, ...needsByGovernorate.shown.map((g) => g.count)),
      needsByGovernorate.shown.map((g) => ({ label: g.name, value: g.count })),
      { graduated: true },
    );
    if (needsByGovernorate.truncated) renderShowingOf(pdf, needsByGovernorate.shown.length, needsByGovernorate.total);
  });
  const p3bEnd2 = pdf.column(pdf.rx + pdf.rw / 2 + 8, pdf.rw / 2 - 8, p3bStart, () => {
    renderBarsChart(
      pdf,
      'Needs by Center',
      Math.max(1, ...needsByCenter.shown.map((g) => g.count)),
      needsByCenter.shown.map((g) => ({ label: g.name, value: g.count })),
      { graduated: true },
    );
    if (needsByCenter.truncated) renderShowingOf(pdf, needsByCenter.shown.length, needsByCenter.total);
  });
  pdf.y = Math.max(p3bEnd1, p3bEnd2) + 4;

  sectionHeading(pdf, 6, 'Needs by Sub-Domain');
  const subDomainBars = capBreakdown(needSubDomains, GEO_CHART_LIMIT).shown.map((d) => ({
    label: `${d.domainName} — ${d.subDomainName}`,
    value: d.needCount,
  }));
  renderLabeledBarsChart(pdf, '', Math.max(1, ...subDomainBars.map((b) => b.value)), subDomainBars);
  if (needSubDomains.length > GEO_CHART_LIMIT) renderShowingOf(pdf, subDomainBars.length, needSubDomains.length);
  pdf.y += 4;

  sectionHeading(pdf, 7, 'Pattern & Intersection Analysis');
  renderCaption(pdf, 'Strongest Region x Domain combinations — where Needs concentrate by both dimensions at once.');
  if (domainRegionIntersections.length === 0) {
    pdf.text(pdf.rx + 2, 8.5, false, 'No classified Needs with an assigned region yet.', GRAY);
    pdf.y += 14;
  } else {
    renderSection(pdf, {
      kind: 'table',
      heading: '',
      columns: ['Region', 'Domain', 'Needs'],
      rows: domainRegionIntersections.map((c) => [c.regionName, c.domainName, String(c.needCount)]),
    });
  }
  drawFooter(pdf, 3);

  // ---- Page 4 — Public Survey Overview ----
  pdf.newPage();
  drawPageFrame(pdf);
  drawRunhead(pdf, condensedScope, 4);
  pageTitle(pdf, 'Public Survey Overview');

  sectionHeading(pdf, 1, 'Survey Approval Status & Average Yield');
  const p4Start = pdf.y;
  const p4End1 = pdf.column(pdf.rx, pdf.rw / 2 - 8, p4Start, () => {
    renderDonut(pdf, null, '', 'SURVEYS', surveyStatusSlices);
  });
  const p4End2 = pdf.column(pdf.rx + pdf.rw / 2 + 8, pdf.rw / 2 - 8, p4Start, () => {
    pdf.y += 8;
    pdf.text(pdf.rx, 28, true, surveyAnalytics.avgResponsesPerPublishedSurvey.toFixed(1), ACCENT);
    pdf.y += 34;
    pdf.text(pdf.rx, 8.5, false, 'Avg. Responses / Published Survey', GRAY);
    pdf.y += 20;
    // The label used to sit beside the sparkline, level with its endpoint —
    // a trend that rises toward its own peak (the common case) puts the
    // line's rising tail right at the label's height, reading as the line
    // running into the text even with a clear horizontal gap. Putting the
    // label below the sparkline instead, with its own vertical gap, keeps
    // it clear of the line's trajectory no matter which way the trend goes.
    const sparkTopY = pdf.y;
    const sparkW = 90;
    const sparkH = 18;
    const sparkLabelSize = 7.5;
    renderSparkline(pdf, pdf.rx, sparkTopY, sparkW, sparkH, responseAnalytics.monthlyTrend.map((p) => p.count));
    pdf.y = sparkTopY + sparkH + 9;
    pdf.text(pdf.rx, sparkLabelSize, false, 'Last 12 months', GRAY);
    pdf.y += sparkLabelSize + 2;
  });
  pdf.y = Math.max(p4End1, p4End2) + 4;

  sectionHeading(pdf, 2, 'Rejection Reason Breakdown');
  // Counts historical rejection events (see NcnpReportService), not
  // surveys currently sitting at REJECTED — check the breakdown itself,
  // not statusPlatformWide.rejected, so a rejected-then-corrected-then-
  // published survey still shows its rejection history here.
  if (surveyAnalytics.rejectionReasonBreakdown.length === 0) {
    pdf.text(pdf.rx + 2, 8.5, false, 'No rejected surveys recorded for this period yet.', GRAY);
    pdf.y += 14;
  } else {
    const rejectionReasonBars = surveyAnalytics.rejectionReasonBreakdown.map((r) => ({
      label: `${r.reasonCode} — ${REJECTION_REASON_LABELS[r.reasonCode] ?? r.reasonCode}`,
      value: r.count,
    }));
    renderLabeledBarsChart(
      pdf,
      '',
      Math.max(1, ...rejectionReasonBars.map((r) => r.value)),
      rejectionReasonBars,
    );
  }
  pdf.y += 4;

  sectionHeading(pdf, 3, 'Geographic Distribution');
  const survByRegion = capBreakdown(surveyGeography.byRegion, REGION_CHART_LIMIT);
  const survByGovernorate = capBreakdown(surveyGeography.byGovernorate);
  const survByCenter = capBreakdown(surveyGeography.byCenter);
  renderColumnChart(
    pdf,
    'Survey Distribution by Region',
    Math.max(1, ...survByRegion.shown.map((g) => g.count)),
    survByRegion.shown.map((g) => ({ label: g.name, value: g.count })),
  );
  if (survByRegion.truncated) renderShowingOf(pdf, survByRegion.shown.length, survByRegion.total);
  pdf.y += 4;
  const p4bStart = pdf.y;
  const p4bEnd1 = pdf.column(pdf.rx, pdf.rw / 2 - 8, p4bStart, () => {
    renderBarsChart(
      pdf,
      'Survey Distribution by Governorate',
      Math.max(1, ...survByGovernorate.shown.map((g) => g.count)),
      survByGovernorate.shown.map((g) => ({ label: g.name, value: g.count })),
      { graduated: true },
    );
    if (survByGovernorate.truncated) renderShowingOf(pdf, survByGovernorate.shown.length, survByGovernorate.total);
  });
  const p4bEnd2 = pdf.column(pdf.rx + pdf.rw / 2 + 8, pdf.rw / 2 - 8, p4bStart, () => {
    renderBarsChart(
      pdf,
      'Survey Distribution by Center',
      Math.max(1, ...survByCenter.shown.map((g) => g.count)),
      survByCenter.shown.map((g) => ({ label: g.name, value: g.count })),
      { graduated: true },
    );
    if (survByCenter.truncated) renderShowingOf(pdf, survByCenter.shown.length, survByCenter.total);
  });
  pdf.y = Math.max(p4bEnd1, p4bEnd2) + 4;

  // Keep the heading + caption + full table together — an orphaned heading
  // with the table itself splitting away onto the next page reads as a
  // broken table, not just an extra page.
  const statusByRegionMap = new Map(surveyAnalytics.statusByRegion.map((r) => [r.regionId, r.status]));
  // Generous on purpose: renderTable's per-row ensure() has no header-repeat
  // logic, so underestimating here lets only the last row or two spill onto
  // an otherwise blank next page with no header — worse than the whole
  // table just starting fresh. Overestimating costs nothing but a slightly
  // earlier page break.
  pdf.ensure(23 + 16 + 16 + regionSummary.length * 13 + 12);
  sectionHeading(pdf, 4, 'By Region — Summary');
  renderCaption(pdf, 'Surfaces whether rejection/draft backlog is concentrated in specific regions.');
  renderSection(pdf, {
    kind: 'table',
    heading: '',
    columns: ['Region', 'Surveys', 'Responses', 'Avg / Survey', 'Draft', 'Submitted', 'Published', 'Rejected'],
    rows: regionSummary.map((r) => {
      const status = statusByRegionMap.get(r.regionId);
      return [
        r.regionName,
        String(r.surveyCount),
        String(r.responseCount),
        r.avgResponsesPerSurvey.toFixed(1),
        String(status?.draft ?? 0),
        String(status?.submitted ?? 0),
        String(status?.published ?? 0),
        String(status?.rejected ?? 0),
      ];
    }),
  });
  drawFooter(pdf, 4);

  // ---- Page 5 — Response Analytics ----
  pdf.newPage();
  drawPageFrame(pdf);
  drawRunhead(pdf, condensedScope, 5);
  pageTitle(pdf, 'Response Analytics');

  sectionHeading(pdf, 1, 'Response Trend');
  renderTrendLine(pdf, 'Monthly Responses — last 12 months', responseAnalytics.monthlyTrend);
  pdf.y += 6;

  sectionHeading(pdf, 2, 'Geographic Performance');
  renderBarsChart(
    pdf,
    'Responses by Region',
    Math.max(1, ...responseAnalytics.responsesByRegion.map((r) => r.count)),
    responseAnalytics.responsesByRegion.map((r) => ({ label: r.regionName, value: r.count })),
  );
  pdf.y += 6;

  sectionHeading(pdf, 3, 'Organization Response Performance');
  const p5Start = pdf.y;
  const p5End1 = pdf.column(pdf.rx, pdf.rw / 2 - 8, p5Start, () => {
    renderBarsChart(
      pdf,
      'Top Organizations — by Total Responses',
      Math.max(1, ...responseAnalytics.topOrgsByTotalResponses.map((o) => o.value)),
      responseAnalytics.topOrgsByTotalResponses.map((o) => ({ label: o.organizationName, value: o.value })),
    );
    if (responseAnalytics.topOrgsByTotalResponses.length > 0) {
      renderShowingOf(pdf, responseAnalytics.topOrgsByTotalResponses.length, summary.totals.organizations);
    }
  });
  const p5End2 = pdf.column(pdf.rx + pdf.rw / 2 + 8, pdf.rw / 2 - 8, p5Start, () => {
    renderBarsChart(
      pdf,
      'Top Organizations — by Avg. Responses / Survey',
      Math.max(1, ...responseAnalytics.topOrgsByAvgResponsesPerSurvey.map((o) => o.value)),
      responseAnalytics.topOrgsByAvgResponsesPerSurvey.map((o) => ({
        label: o.organizationName,
        value: Math.round(o.value * 10) / 10,
      })),
    );
    if (responseAnalytics.topOrgsByAvgResponsesPerSurvey.length > 0) {
      renderShowingOf(pdf, responseAnalytics.topOrgsByAvgResponsesPerSurvey.length, summary.totals.organizations);
    }
  });
  pdf.y = Math.max(p5End1, p5End2) + 6;

  sectionHeading(pdf, 4, 'Demographics');
  chartTitle(pdf, 'Gender Distribution');
  renderDonut(
    pdf,
    null,
    '',
    'RESPONSES',
    // AGE_BRACKET_COLORS, not CHART_CYCLE — CHART_1/CHART_2 (steel blue-gray
    // and sage green) sit too close in hue/lightness to tell apart at a
    // glance, which is exactly what happened with Female/Male. This palette
    // is the validated CVD-safe categorical set already used for Age
    // Distribution's up-to-7 slices, so 2-4 gender segments read distinctly.
    responseAnalytics.genderDistribution.map((g, i) => ({ label: GENDER_LABELS[g.gender] ?? g.gender, value: g.count, color: AGE_BRACKET_COLORS[i % AGE_BRACKET_COLORS.length]! })),
  );
  pdf.y += 4;

  if (responseAnalytics.hasResponsesWithoutAgeBracket) {
    renderCaption(pdf, 'Age demographics are available only for responses collected after the feature go-live date.');
  }
  const ageTotal = responseAnalytics.ageBracketDistribution.reduce((sum, a) => sum + a.count, 0);
  if (ageTotal === 0) {
    chartTitle(pdf, 'Age Distribution');
    pdf.text(pdf.rx + 2, 8.5, false, 'No age-bracket data available for this period yet.', GRAY);
    pdf.y += 14;
  } else {
    const ageCountByBracket = new Map(responseAnalytics.ageBracketDistribution.map((a) => [a.ageBracket, a.count]));
    const ageBracketSlices = AGE_BRACKET_ORDER.filter((key) => (ageCountByBracket.get(key) ?? 0) > 0).map((key, i) => ({
      label: AGE_BRACKET_LABELS[key] ?? key,
      value: ageCountByBracket.get(key) ?? 0,
      color: AGE_BRACKET_COLORS[i % AGE_BRACKET_COLORS.length]!,
    }));
    renderPieChart(pdf, 'Age Distribution', ageBracketSlices);
  }
  drawFooter(pdf, 5);

  // ---- Page 6 — Priority & Scoring Overview ----
  pdf.newPage();
  drawPageFrame(pdf);
  drawRunhead(pdf, condensedScope, 6);
  pageTitle(pdf, 'Priority & Scoring Overview');

  renderDonut(
    pdf,
    1,
    'Village Priority Classification',
    'VILLAGES',
    priorityOverview.byStatus.map((s) => ({
      label: s.status,
      value: s.count,
      color: s.status === 'HIGH' ? DESTRUCTIVE : s.status === 'MEDIUM' ? WARNING : CHART_4,
    })),
  );
  pdf.y += 10;

  sectionHeading(pdf, 2, 'Domain Comparison — Avg. Performance Score');
  renderBarsChart(
    pdf,
    '',
    100,
    priorityOverview.domainComparison.map((d) => ({ label: d.domainName, value: Math.round(d.avgPerformanceScore) })),
  );
  pdf.y += 16;

  sectionHeading(pdf, 3, 'Highest-Priority Villages');
  if (priorityOverview.topPriorityVillages.length > 0) {
    renderVillageTable(pdf, priorityOverview.topPriorityVillages);
  } else {
    renderSection(pdf, { kind: 'note', heading: '', text: 'No village-level priority assessments recorded yet.' });
  }
  pdf.y += 10;

  // Need-level (not village-level) — score/evidence/gap/source per Need,
  // ranked by the same village-priority assessment used for Page 1's Top
  // Critical Needs (see NcnpReportService.buildCriticalNeeds for exactly
  // how "gap" and "source" are derived from real, existing data).
  sectionHeading(pdf, 4, 'Priority Needs');
  renderCaption(pdf, 'Score, evidence, primary gap, equity flag, and source per Need — ranked most critical first.');
  if (criticalNeeds.priorityNeeds.length === 0) {
    renderSection(pdf, { kind: 'note', heading: '', text: 'No Needs have a village-priority assessment yet.' });
  } else {
    renderSection(pdf, {
      kind: 'table',
      heading: '',
      // Full Unified Need Record column set, matching Excel/UI — renderTable
      // auto-shrinks font size and column widths (and wraps cells up to 2
      // lines) once past 6 columns, same mechanism already used for the
      // 8-column By Region — Summary table on Page 4.
      columns: ['Need', 'Domain', 'Score', 'Status', 'Equity', 'Primary Gap', 'Indicator', 'Region', 'Evidence', 'Source', 'Source Ref'],
      rows: criticalNeeds.priorityNeeds.map((n) => [
        n.needTitle,
        n.domain ?? '—',
        n.priorityScore.toFixed(1),
        n.priorityStatus,
        n.equityFlag ? 'Yes' : 'No',
        n.primaryGap ?? '—',
        n.indicatorId ?? '—',
        n.unitGeoRegion ?? '—',
        String(n.evidenceCount),
        NEED_SOURCE_LABELS[n.source] ?? n.source,
        n.sourceRef ?? '—',
      ]),
    });
    if (criticalNeeds.totalRankableNeeds > criticalNeeds.priorityNeeds.length) {
      renderShowingOf(pdf, criticalNeeds.priorityNeeds.length, criticalNeeds.totalRankableNeeds);
    }
  }
  pdf.y += 10;

  // Mandatory — present even when every count is zero (e.g. no quality
  // assessments have been run yet), never omitted just because nothing has
  // happened. Every number here is real; a zero means exactly that.
  sectionHeading(pdf, 5, 'Data Quality Notes');
  const assessedPct = dataQualityNotes.totalResponses === 0 ? 0 : (dataQualityNotes.assessedResponses / dataQualityNotes.totalResponses) * 100;
  renderKpiTiles(
    pdf,
    [
      { label: 'Responses Quality-Assessed', value: `${dataQualityNotes.assessedResponses} / ${dataQualityNotes.totalResponses} (${assessedPct.toFixed(0)}%)` },
      { label: 'Low-Confidence Responses', value: dataQualityNotes.lowConfidenceCount },
      { label: 'Duplicate-Flagged Responses', value: dataQualityNotes.duplicateFlaggedCount },
      { label: 'Needs With Evidence', value: `${dataQualityNotes.needsWithEvidence} of ${dataQualityNotes.totalNeeds}` },
      { label: 'Needs Without Evidence', value: dataQualityNotes.needsWithoutEvidence },
      { label: 'Needs Not Yet Classified', value: dataQualityNotes.needsUnclassified },
    ],
    3,
  );
  if (dataQualityNotes.assessedResponses === 0) {
    pdf.y += 4;
    renderCaption(pdf, 'No response-quality assessments have been run yet for this period.');
  }
  pdf.y += 10;

  // Closing colophon — cumulative totals with this period's growth alongside
  // them (not a bare restatement of Page 1's totals), same content the live
  // UI closes on.
  pdf.rule(GRAY, 0.6);
  pdf.y += 6;
  const colophonStats: Array<[string, number, number]> = [
    ['Organizations', summary.totals.organizations, summary.newThisPeriod.organizations.current],
    ['Studies', summary.totals.studies, summary.newThisPeriod.studies.current],
    ['Surveys', summary.totals.surveys, summary.newThisPeriod.surveys.current],
    ['Responses', summary.totals.responses, summary.newThisPeriod.responses.current],
  ];
  const colW = pdf.rw / colophonStats.length;
  const colophonTop = pdf.y;
  colophonStats.forEach(([label, total, delta], i) => {
    const x = pdf.rx + i * colW;
    pdf.y = colophonTop;
    const totalStr = total.toLocaleString();
    pdf.text(x, 12, true, totalStr);
    pdf.text(x + textWidth(totalStr, 12) + 4, 8, false, label, GRAY);
    pdf.y = colophonTop + 14;
    pdf.text(x, 8, true, `(+${delta.toLocaleString()})`, CHART_4);
    pdf.y = colophonTop + 25;
    pdf.text(x, 6.5, false, 'vs previous period', GRAY);
  });
  pdf.y = colophonTop + 34;
  drawFooter(pdf, 6);

  return pdf.build();
}
