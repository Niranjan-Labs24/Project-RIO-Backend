// Shared shape-agnostic flattening used by both export formats: each report
// type's `content` is a different hand-built object (see
// reports.service.ts#generateContent), so rather than a bespoke renderer per
// report type, both exporters walk the same generic "Field / Value" pairs,
// with any top-level array-of-objects field broken out as its own table.

export interface FlattenedContent {
  summaryRows: Array<{ field: string; value: string }>;
  tables: Array<{ name: string; rows: Array<Record<string, unknown>> }>;
}

function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function flattenReportContent(content: Record<string, unknown>): FlattenedContent {
  const summaryRows: FlattenedContent["summaryRows"] = [];
  const tables: FlattenedContent["tables"] = [];

  for (const [key, value] of Object.entries(content)) {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
      tables.push({ name: key, rows: value as Array<Record<string, unknown>> });
      continue;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        summaryRows.push({ field: `${key}.${nestedKey}`, value: stringifyScalar(nestedValue) });
      }
      continue;
    }
    summaryRows.push({ field: key, value: stringifyScalar(value) });
  }

  return { summaryRows, tables };
}
