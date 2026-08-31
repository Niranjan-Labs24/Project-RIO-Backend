import { DETECTED_LANGUAGE_PROPERTY, LANGUAGE_RULE } from './language-rule';

export const PRIORITY_DASHBOARD_SUMMARY_PROMPT_VERSION = 'priority-dashboard-summary-v2';

export const PRIORITY_DASHBOARD_SUMMARY_SYSTEM_PROMPT = `You are an analytical report-writing assistant for a community needs assessment platform.

Use only the provided ReportData JSON and approved Evidence JSON.

Do not calculate, modify, estimate, or reinterpret numerical scores.
Do not invent facts, trends, causes, affected groups, locations, statistics, or recommendations not supported by supplied data.
Do not expose individual respondent information or PII.
Do not claim that a finding is certain when confidence is LOW.
If assessmentCycle is 1, do not infer improvement or decline; use the exact string supplied as TREND_PENDING_TEXT in the input
Use the exact Priority Status, Severity Score, Priority Score, and Critical Override reason supplied in ReportData.
Clearly separate calculated findings from qualitative evidence.
If data is unavailable, write the exact string supplied as DATA_UNAVAILABLE_TEXT in the input

Return valid JSON only, using the exact output schema provided.` + LANGUAGE_RULE;

export const PRIORITY_DASHBOARD_SUMMARY_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    // Cross-check only, never a source of truth — the language a stored
    // narrative is actually in is verified with detectLanguage(), not taken
    // from the model's own word for it. Optional, so a response stored
    // before this field existed stays parseable.
    ...DETECTED_LANGUAGE_PROPERTY,
    executiveSummary: { type: 'STRING' },
    priorityExplanation: { type: 'STRING' },
    keyFindings: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          domain: { type: 'STRING' },
          kpi: { type: 'STRING' },
          severityScore: { type: 'NUMBER', nullable: true },
          confidence: { type: 'STRING' },
          summary: { type: 'STRING' },
        },
        required: ['title', 'domain', 'kpi', 'confidence', 'summary'],
      },
    },
    domainInsights: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          domain: { type: 'STRING' },
          severityScore: { type: 'NUMBER', nullable: true },
          performanceScore: { type: 'NUMBER', nullable: true },
          priorityContribution: { type: 'NUMBER', nullable: true },
          confidence: { type: 'STRING' },
          summary: { type: 'STRING' },
        },
        required: ['domain', 'confidence', 'summary'],
      },
    },
    criticalOverrideNote: { type: 'STRING', nullable: true },
    dataQualityNote: { type: 'STRING' },
    evidenceSummary: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          evidenceTitle: { type: 'STRING' },
          sourceReferenceId: { type: 'STRING' },
          linkedDomainOrKpi: { type: 'STRING' },
          summary: { type: 'STRING' },
        },
        required: ['evidenceTitle', 'sourceReferenceId', 'linkedDomainOrKpi', 'summary'],
      },
    },
    trendNote: { type: 'STRING' },
    draftNextSteps: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
  },
  required: [
    'executiveSummary',
    'priorityExplanation',
    'keyFindings',
    'domainInsights',
    'dataQualityNote',
    'evidenceSummary',
    'trendNote',
    'draftNextSteps',
  ],
};
