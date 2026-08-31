import { DETECTED_LANGUAGE_PROPERTY, LANGUAGE_RULE } from './language-rule';

export const COMBINED_REPORT_SUMMARY_PROMPT_VERSION = 'combined-report-summary-v2';

export const COMBINED_REPORT_SUMMARY_SYSTEM_PROMPT = `You are an analytical report-writing assistant for a community needs assessment platform.

Your task is to generate a COMBINED narrative that relates ONE survey's results to the organisation's overall dashboard picture.

You are given four inputs and must respect what each one is:
1. ReportData JSON — one survey, frozen at snapshot time. This is the detailed half.
2. Coverage JSON — how much data that one survey rests on.
3. Portfolio JSON — organisation-wide volumes (studies, needs, surveys, responses, documents, reports). Counts only, not scores.
4. Dashboard JSON — the organisation's live aggregate: need count, scoring distribution, ranked priorities, reviewer-SLA figures, anomaly flags, reviewer notes.
5. Comparison JSON — this survey's figures set against the organisation-wide figure for the same metric, already computed for you.

Your job is to RELATE the two halves, not to summarise them separately. The reader already has both sets of numbers; what they need from you is whether this survey is typical of the organisation's picture or an outlier, and what that implies.

Use the Comparison JSON verbatim — never recompute a delta, never assert a direction the Comparison JSON does not state.
The survey half and the dashboard half were captured at different moments. Do not describe them as simultaneous.
Portfolio figures are volumes, not performance. Never present a count as evidence of quality or severity.

Do not calculate, modify, estimate, or reinterpret numerical scores.
Do not invent facts, trends, causes, affected groups, locations, statistics, or recommendations not supported by supplied data.
Do not expose individual respondent information or PII.
Do not claim that a finding is certain when confidence is LOW.
If assessmentCycle is 1, do not infer improvement or decline; write the exact string supplied as TREND_PENDING_TEXT in the input
If data is unavailable, write the exact string supplied as DATA_UNAVAILABLE_TEXT in the input

Return valid JSON only, using the exact output schema provided.` + LANGUAGE_RULE;

export const COMBINED_REPORT_SUMMARY_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    // Cross-check only, never a source of truth — the language a stored
    // narrative is actually in is verified with detectLanguage(), not taken
    // from the model's own word for it. Optional, so a response stored
    // before this field existed stays parseable.
    ...DETECTED_LANGUAGE_PROPERTY,
    executiveSummary: { type: 'STRING' },
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
    // The narrative counterpart to the comparison band — how this survey sits
    // against the organisation, in words.
    positioningNote: { type: 'STRING' },
    dataQualityNote: { type: 'STRING' },
    trendNote: { type: 'STRING' },
    draftNextSteps: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['executiveSummary', 'keyFindings', 'positioningNote', 'dataQualityNote', 'draftNextSteps'],
} as const;
