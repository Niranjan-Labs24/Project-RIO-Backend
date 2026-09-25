/**
 * Client-reported (2026-09-24): the audit log's before/after dialog showed
 * raw camelCase db/property identifiers (`gapType`, `isActive`,
 * `governorateIds`, `approvalStatus`, ...) instead of a human-readable field
 * name — AuditFieldChange.field's own doc comment promises "already
 * localised/denormalised for display", but several call sites across the
 * app never honoured that contract. This matters beyond cosmetics: the
 * frontend now runs every `field`/`before`/`after` value through
 * AutoTranslate for Arabic (see change-details-dialog.tsx /
 * audit-detail-drawer.tsx), and a raw identifier is a poor, often-untranslated
 * input to a machine translator — a clean English phrase like "Gap Type"
 * translates properly; "gapType" often doesn't.
 *
 * Single shared map so the same db field never gets two different display
 * names depending on which service happened to record the change (the same
 * "one report must not name the same thing two different ways" reasoning
 * ncnp-report-labels.ts already applies to enum values).
 */
const AUDIT_FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  region: 'Region',
  regionId: 'Region',
  email: 'Email',
  sector: 'Sector',
  purpose: 'Purpose',
  logoUrl: 'Logo',
  villages: 'Villages',
  isActive: 'Active',
  title: 'Title',
  methodologyVersionId: 'Methodology Version',
  governorateIds: 'Governorates',
  centerIds: 'Centers',
  gapType: 'Gap Type',
  urgency: 'Urgency',
  themes: 'Themes',
  status: 'Status',
  imported: 'Imported',
  score: 'Score',
  overrideReason: 'Override Reason',
  approvalStatus: 'Approval Status',
  questionText: 'Question Text',
  questionTextAr: 'Question Text (Arabic)',
  indicator: 'Indicator',
  indicatorAr: 'Indicator (Arabic)',
  kpi: 'KPI',
  kpiAr: 'KPI (Arabic)',
  domain: 'Domain',
  subDomain: 'Sub-Domain',
};

/** Title-Cases a camelCase identifier as a last resort (e.g. an unmapped
 *  field added later) — never as good as a reviewed label above, but always
 *  better than the raw identifier, and consistent with every other map in
 *  this codebase falling back rather than dropping the row. */
function titleCaseFallback(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

export function auditFieldLabel(key: string): string {
  return AUDIT_FIELD_LABELS[key] ?? titleCaseFallback(key);
}
