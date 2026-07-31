import type { DocSection, ReportDoc } from '../reports/report-doc';
import type { NcnpOrgSummaryRow, NcnpReport } from './ncnp-report.types';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function pct(stat: { current: number; previous: number; changePct: number | null }): string {
  if (stat.changePct === null) return `${stat.current} (new)`;
  const sign = stat.changePct > 0 ? '+' : '';
  return `${stat.current} (${sign}${stat.changePct.toFixed(1)}% vs. prior period)`;
}

// Matches the Prisma RejectionReasonCode enum's identifiers — UNSPECIFIED
// covers surveys rejected before this field existed (see
// NcnpReportService.buildSurveyAnalytics). Kept local to this file (not
// shared with ncnp-report-pdf.ts) — each renderer here is self-contained.
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
// Type terminology — see ncnp-report-pdf.ts's copy of this same map for why
// 'manual_entry' displays as "Survey" and why 'citizen_input'/'field_survey'
// are kept even though nothing produces them yet.
const NEED_SOURCE_LABELS: Record<string, string> = {
  manual_entry: 'Survey',
  file_upload: 'Uploaded Document',
  citizen_input: 'Citizen Input',
  field_survey: 'Field Survey',
};

// Maps the live NcnpReport payload into the same render-agnostic ReportDoc
// model every other report export already uses (see report-doc.ts) — reuses
// the existing renderReportPdf/renderReportExcel renderers unchanged rather
// than building a second PDF/Excel pipeline for one report type.
export function buildNcnpReportDoc(
  report: NcnpReport,
  generatedByName: string,
  auditRows?: Array<{ label: string; value: string }>,
): ReportDoc {
  const {
    summary,
    orgHealth,
    orgSummary,
    needDomains,
    needSubDomains,
    needsGeography,
    studyStatus,
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

  const sections: DocSection[] = [
    {
      kind: 'keyvalue',
      heading: 'Platform Summary',
      rows: [
        { label: 'Organizations', value: pct({ ...summary.newThisPeriod.organizations, current: summary.totals.organizations }) },
        { label: 'Studies', value: pct({ ...summary.newThisPeriod.studies, current: summary.totals.studies }) },
        { label: 'Surveys', value: pct({ ...summary.newThisPeriod.surveys, current: summary.totals.surveys }) },
        { label: 'Responses', value: pct({ ...summary.newThisPeriod.responses, current: summary.totals.responses }) },
        { label: 'Total Needs', value: String(summary.totals.needs) },
      ],
    },
    criticalNeeds.topCriticalNeeds.length === 0
      ? { kind: 'note', heading: 'Top Critical Needs', text: 'No Needs have a village-priority assessment yet — nothing to rank.' }
      : {
          kind: 'list',
          heading: 'Top Critical Needs',
          items: criticalNeeds.topCriticalNeeds.map(
            (n) => `${n.needTitle} (${n.organizationName} — ${n.domain ?? 'Unclassified'}) — ${n.priorityStatus}, score ${n.priorityScore.toFixed(1)}`,
          ),
        },
    {
      kind: 'keyvalue',
      heading: 'Organization Health',
      rows: [
        { label: 'Active', value: String(orgHealth.active) },
        { label: 'Inactive', value: String(orgHealth.inactive) },
        { label: `Dormant (${orgHealth.dormantDays}+ days inactive)`, value: String(orgHealth.dormant) },
      ],
    },
  ];

  if (orgHealth.needsAttention.length > 0) {
    sections.push({
      kind: 'table',
      heading: 'Organizations Needing Attention',
      columns: ['Organization', 'Last Activity'],
      rows: orgHealth.needsAttention.map((o) => [o.organizationName, o.lastActivity ? fmtDate(o.lastActivity) : 'No recorded activity']),
    });
  }

  const orgSummaryLists: Array<{ rows: NcnpOrgSummaryRow[]; label: string; value: (r: NcnpOrgSummaryRow) => number }> = [
    { rows: orgSummary.byStudies, label: 'Studies', value: (r) => r.studyCount },
    { rows: orgSummary.bySurveys, label: 'Surveys', value: (r) => r.surveyCount },
    { rows: orgSummary.byResponses, label: 'Responses', value: (r) => r.responseCount },
  ];
  for (const { rows, label, value } of orgSummaryLists) {
    sections.push({
      kind: 'table',
      heading: `Top Organizations — by ${label} (top ${rows.length} of ${orgSummary.totalOrganizations})`,
      columns: ['Organization', label, 'Status'],
      rows: rows.map((r) => [r.organizationName, String(value(r)), r.isActive ? 'Active' : 'Inactive']),
    });
  }

  sections.push({
    kind: 'bars',
    heading: 'Need Categories — by Domain',
    max: Math.max(1, ...needDomains.map((d) => d.needCount)),
    bars: needDomains.map((d) => ({ label: d.domainName, value: d.needCount })),
  });

  sections.push({
    kind: 'bars',
    heading: 'Needs by Sub-Domain',
    max: Math.max(1, ...needSubDomains.map((d) => d.needCount)),
    bars: needSubDomains.map((d) => ({ label: `${d.domainName} — ${d.subDomainName}`, value: d.needCount })),
  });

  // Kingdom-wide rollup of Needs themselves — distinct from the
  // Organizations-by-Region/Governorate/Center breakdown below, which
  // counts organizations, not individual Needs.
  sections.push({
    kind: 'columns',
    children: [
      {
        kind: 'bars',
        heading: 'Needs by Region',
        max: Math.max(1, ...needsGeography.byRegion.map((g) => g.count)),
        bars: needsGeography.byRegion.map((g) => ({ label: g.name, value: g.count })),
      },
      {
        kind: 'bars',
        heading: 'Needs by Governorate',
        max: Math.max(1, ...needsGeography.byGovernorate.map((g) => g.count)),
        bars: needsGeography.byGovernorate.map((g) => ({ label: g.name, value: g.count })),
      },
    ],
  });

  sections.push({
    kind: 'bars',
    heading: 'Needs by Center',
    max: Math.max(1, ...needsGeography.byCenter.map((g) => g.count)),
    bars: needsGeography.byCenter.map((g) => ({ label: g.name, value: g.count })),
  });

  if (domainRegionIntersections.length > 0) {
    sections.push({
      kind: 'table',
      heading: 'Pattern & Intersection Analysis — Region x Domain',
      columns: ['Region', 'Domain', 'Needs'],
      rows: domainRegionIntersections.map((c) => [c.regionName, c.domainName, String(c.needCount)]),
    });
  }

  sections.push({
    kind: 'pie',
    heading: 'Study Status',
    slices: [
      { label: 'Active', value: studyStatus.active },
      { label: 'Archived', value: studyStatus.archived },
    ],
  });

  sections.push({
    kind: 'columns',
    children: [
      {
        kind: 'bars',
        heading: 'Organizations by Region',
        max: Math.max(1, ...geography.organizationsByRegion.map((g) => g.count)),
        bars: geography.organizationsByRegion.map((g) => ({ label: g.name, value: g.count })),
      },
      {
        kind: 'bars',
        heading: 'Studies by Region',
        max: Math.max(1, ...geography.studiesByRegion.map((g) => g.count)),
        bars: geography.studiesByRegion.map((g) => ({ label: g.name, value: g.count })),
      },
    ],
  });

  sections.push({
    kind: 'columns',
    children: [
      {
        kind: 'bars',
        heading: 'Organizations by Governorate',
        max: Math.max(1, ...geography.organizationsByGovernorate.map((g) => g.count)),
        bars: geography.organizationsByGovernorate.map((g) => ({ label: g.name, value: g.count })),
      },
      {
        kind: 'bars',
        heading: 'Organizations by Center',
        max: Math.max(1, ...geography.organizationsByCenter.map((g) => g.count)),
        bars: geography.organizationsByCenter.map((g) => ({ label: g.name, value: g.count })),
      },
    ],
  });

  sections.push({
    kind: 'columns',
    children: [
      {
        kind: 'table',
        heading: 'Organizations with the Highest Number of Studies',
        columns: ['Organization', 'Studies'],
        rows: studyOverview.topOrgsByStudyCount.map((o) => [o.organizationName, String(o.studyCount)]),
      },
      {
        kind: 'bars',
        heading: 'Studies Created — Last 12 Months',
        max: Math.max(1, ...studyOverview.studiesCreatedTrend.map((p) => p.count)),
        bars: studyOverview.studiesCreatedTrend.map((p) => ({ label: p.month, value: p.count })),
      },
    ],
  });

  sections.push({
    kind: 'columns',
    children: [
      {
        kind: 'bars',
        heading: 'Surveys by Governorate',
        max: Math.max(1, ...surveyGeography.byGovernorate.map((g) => g.count)),
        bars: surveyGeography.byGovernorate.map((g) => ({ label: g.name, value: g.count })),
      },
      {
        kind: 'bars',
        heading: 'Surveys by Center',
        max: Math.max(1, ...surveyGeography.byCenter.map((g) => g.count)),
        bars: surveyGeography.byCenter.map((g) => ({ label: g.name, value: g.count })),
      },
    ],
  });

  if (regionSummary.length > 0) {
    sections.push({
      kind: 'table',
      heading: 'By Region — Summary',
      columns: ['Region', 'Surveys', 'Responses', 'Avg / Survey'],
      rows: regionSummary.map((r) => [r.regionName, String(r.surveyCount), String(r.responseCount), r.avgResponsesPerSurvey.toFixed(1)]),
    });
  }

  sections.push({
    kind: 'pie',
    heading: 'Survey Approval Status — Platform-Wide',
    slices: [
      { label: 'Draft', value: surveyAnalytics.statusPlatformWide.draft },
      { label: 'Submitted', value: surveyAnalytics.statusPlatformWide.submitted },
      { label: 'Published', value: surveyAnalytics.statusPlatformWide.published },
      { label: 'Rejected', value: surveyAnalytics.statusPlatformWide.rejected },
    ],
  });

  sections.push({
    kind: 'note',
    heading: 'Average Response Yield',
    text: `${surveyAnalytics.avgResponsesPerPublishedSurvey.toFixed(1)} average responses per published survey, platform-wide.`,
  });

  // Counts historical rejection events (see NcnpReportService), not
  // surveys currently sitting at REJECTED — check the breakdown itself,
  // not statusPlatformWide.rejected, so a rejected-then-corrected-then-
  // published survey still shows its rejection history here.
  if (surveyAnalytics.rejectionReasonBreakdown.length === 0) {
    sections.push({
      kind: 'note',
      heading: 'Rejection Reason Breakdown',
      text: 'No rejected surveys recorded for this period yet.',
    });
  } else {
    sections.push({
      kind: 'bars',
      heading: 'Rejection Reason Breakdown',
      max: Math.max(1, ...surveyAnalytics.rejectionReasonBreakdown.map((r) => r.count)),
      bars: surveyAnalytics.rejectionReasonBreakdown.map((r) => ({
        label: `${r.reasonCode} — ${REJECTION_REASON_LABELS[r.reasonCode] ?? r.reasonCode}`,
        value: r.count,
      })),
    });
  }

  if (surveyAnalytics.statusByRegion.length > 0) {
    sections.push({
      kind: 'table',
      heading: 'Survey Approval Status — by Region',
      columns: ['Region', 'Draft', 'Submitted', 'Published', 'Rejected'],
      rows: surveyAnalytics.statusByRegion.map((r) => [
        r.regionName,
        String(r.status.draft),
        String(r.status.submitted),
        String(r.status.published),
        String(r.status.rejected),
      ]),
    });
  }

  sections.push({
    kind: 'bars',
    heading: 'Responses by Region',
    max: Math.max(1, ...responseAnalytics.responsesByRegion.map((r) => r.count)),
    bars: responseAnalytics.responsesByRegion.map((r) => ({ label: r.regionName, value: r.count })),
  });

  sections.push({
    kind: 'pie',
    heading: 'Gender Distribution',
    slices: responseAnalytics.genderDistribution.map((g) => ({ label: GENDER_LABELS[g.gender] ?? g.gender, value: g.count })),
  });

  const ageTotal = responseAnalytics.ageBracketDistribution.reduce((sum, a) => sum + a.count, 0);
  if (ageTotal === 0) {
    sections.push({
      kind: 'note',
      heading: 'Age Distribution',
      text: 'No age-bracket data available for this period yet.',
    });
  } else {
    const ageCountByBracket = new Map(responseAnalytics.ageBracketDistribution.map((a) => [a.ageBracket, a.count]));
    sections.push({
      kind: 'pie',
      heading: 'Age Distribution',
      slices: AGE_BRACKET_ORDER.filter((key) => (ageCountByBracket.get(key) ?? 0) > 0).map((key) => ({
        label: AGE_BRACKET_LABELS[key] ?? key,
        value: ageCountByBracket.get(key) ?? 0,
      })),
    });
  }
  if (responseAnalytics.hasResponsesWithoutAgeBracket) {
    sections.push({
      kind: 'note',
      heading: 'Age Distribution — Note',
      text: 'Age demographics are available only for responses collected after the feature go-live date.',
    });
  }

  sections.push({
    kind: 'columns',
    children: [
      {
        kind: 'bars',
        heading: 'Top Organizations — by Total Responses',
        max: Math.max(1, ...responseAnalytics.topOrgsByTotalResponses.map((o) => o.value)),
        bars: responseAnalytics.topOrgsByTotalResponses.map((o) => ({ label: o.organizationName, value: o.value })),
      },
      {
        kind: 'bars',
        heading: 'Top Organizations — by Avg. Responses / Survey',
        max: Math.max(1, ...responseAnalytics.topOrgsByAvgResponsesPerSurvey.map((o) => o.value)),
        bars: responseAnalytics.topOrgsByAvgResponsesPerSurvey.map((o) => ({
          label: o.organizationName,
          value: Math.round(o.value * 10) / 10,
        })),
      },
    ],
  });

  sections.push({
    kind: 'pie',
    heading: 'Village Priority Classification',
    slices: priorityOverview.byStatus.map((s) => ({ label: s.status, value: s.count })),
  });

  sections.push({
    kind: 'bars',
    heading: 'Domain Comparison — Avg. Performance Score',
    max: 100,
    bars: priorityOverview.domainComparison.map((d) => ({ label: d.domainName, value: Math.round(d.avgPerformanceScore) })),
  });

  if (priorityOverview.topPriorityVillages.length > 0) {
    sections.push({
      kind: 'table',
      heading: 'Highest-Priority Villages',
      columns: ['Village', 'Priority Score', 'Status'],
      rows: priorityOverview.topPriorityVillages.map((v) => [v.villageId, v.priorityScore.toFixed(1), v.priorityStatus]),
    });
  }

  // Need-level (not village-level) — score/evidence/gap/source per Need,
  // ranked most critical first (see NcnpReportService.buildCriticalNeeds).
  if (criticalNeeds.priorityNeeds.length === 0) {
    sections.push({ kind: 'note', heading: 'Priority Needs', text: 'No Needs have a village-priority assessment yet.' });
  } else {
    sections.push({
      kind: 'table',
      heading: `Priority Needs (top ${criticalNeeds.priorityNeeds.length} of ${criticalNeeds.totalRankableNeeds} rankable)`,
      // Excel has no page-width constraint the way the PDF does, so this
      // carries the full Unified Need Record field set — Indicator, Region
      // (unit_geo), and Source Ref included, unlike the PDF's leaner table.
      columns: ['Need', 'Domain', 'Score', 'Status', 'Equity Flag', 'Primary Gap', 'Indicator', 'Region', 'Evidence', 'Source', 'Source Ref'],
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
  }

  // Mandatory — present even when every count is zero, never omitted just
  // because nothing has happened yet (e.g. no quality assessments run).
  sections.push({
    kind: 'keyvalue',
    heading: 'Data Quality Notes',
    rows: [
      { label: 'Responses Quality-Assessed', value: `${dataQualityNotes.assessedResponses} / ${dataQualityNotes.totalResponses}` },
      { label: 'Low-Confidence Responses', value: String(dataQualityNotes.lowConfidenceCount) },
      { label: 'Duplicate-Flagged Responses', value: String(dataQualityNotes.duplicateFlaggedCount) },
      { label: 'Needs With Evidence', value: `${dataQualityNotes.needsWithEvidence} of ${dataQualityNotes.totalNeeds}` },
      { label: 'Needs Without Evidence', value: String(dataQualityNotes.needsWithoutEvidence) },
      { label: 'Needs Not Yet Classified', value: String(dataQualityNotes.needsUnclassified) },
    ],
  });

  return {
    title: 'NCNP Compiled Report',
    headerBand: [
      { label: 'Reporting Period', value: `Last ${summary.newThisPeriod.periodDays} days` },
      { label: 'Dormant Threshold', value: `${orgHealth.dormantDays}+ days inactive` },
      { label: 'Generated On', value: fmtDate(report.generatedAt) },
      { label: 'Generated By', value: generatedByName },
    ],
    sections,
    audit: auditRows ?? [{ label: 'Generated At', value: fmtDate(report.generatedAt) }],
  };
}
