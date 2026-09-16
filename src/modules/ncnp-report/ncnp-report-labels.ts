// Enum → display-label maps shared by the NCNP report's two renderers.
//
// These lived in ncnp-report-doc.ts AND ncnp-report-pdf.ts as byte-identical
// copies, on the deliberate principle that "each renderer here is
// self-contained". That principle is right about LAYOUT — the PDF's 6-page
// structure and the ReportDoc model genuinely share nothing — but wrong about
// these: they are not layout, they are the report's vocabulary, and one report
// must not name the same enum value two different ways depending on whether
// the reader downloaded the PDF or the spreadsheet.
//
// The duplication had not drifted yet. It was going to: RIO-NFR-007 adds an
// Arabic label for every one of these strings, and maintaining two hand-kept
// Arabic copies of the same four maps is how a Gender chart ends up saying
// "ذكر" in one export and "Male" in the other.
//
// Every map here is keyed by a Prisma enum's own identifiers, so an unexpected
// value is a schema change, not a data error — callers fall back to the raw
// identifier rather than dropping the row.

/** Prisma `AgeBracket`. Keys are the enum identifiers; display order is the
 *  enum's own declaration order (see AGE_BRACKET_ORDER). */
export const AGE_BRACKET_LABELS: Record<string, string> = {
  age_15_24: '15–24',
  age_25_34: '25–34',
  age_35_44: '35–44',
  age_45_54: '45–54',
  age_55_64: '55–64',
  age_65_plus: '65+',
  prefer_not_to_say: 'Prefer not to say',
};

/** Display order for AGE_BRACKET_LABELS — matches the Prisma AgeBracket enum's
 *  declaration order, so brackets read youngest-first rather than in whatever
 *  order the aggregate happened to return them. */
export const AGE_BRACKET_ORDER = [
  'age_15_24',
  'age_25_34',
  'age_35_44',
  'age_45_54',
  'age_55_64',
  'age_65_plus',
  'prefer_not_to_say',
];

/** Prisma `Gender`. */
export const GENDER_LABELS: Record<string, string> = {
  male: 'Male',
  female: 'Female',
  other: 'Other',
  prefer_not_to_say: 'Prefer not to say',
};

/**
 * Prisma `NeedSource`, in the client's own Report Type terminology (Survey /
 * Uploaded Document / ...) rather than the raw enum identifiers.
 *
 * 'manual_entry' is a Need entered directly through a form — the same "Survey"
 * provenance the client's report-type naming uses (see
 * docs/ncnp-unified-need-record-schema-analysis.md's source_type analysis).
 * 'citizen_input' / 'field_survey' have no producing code path yet (see
 * Need.source's own schema comment); they are kept so an unexpected value never
 * falls through to the raw enum identifier.
 */
export const NEED_SOURCE_LABELS: Record<string, string> = {
  manual_entry: 'Survey',
  file_upload: 'Uploaded Document',
  citizen_input: 'Citizen Input',
  field_survey: 'Field Survey',
};

/** Prisma `RejectionReasonCode`. UNSPECIFIED covers surveys rejected before the
 *  field existed (see NcnpReportService.buildSurveyAnalytics). */
export const REJECTION_REASON_LABELS: Record<string, string> = {
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
