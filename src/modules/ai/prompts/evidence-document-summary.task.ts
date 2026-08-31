import type { AiTask } from '../ai.task';
import { LANGUAGE_RULE } from './language-rule';
import type { DocumentSummaryOutputJson } from '../../evidence/document-summary.service';

/** Every cited item carries the document reference it came from. */
const CITED_ITEM = (valueKey: string) => ({
  type: 'OBJECT',
  properties: {
    [valueKey]: { type: 'STRING' },
    sourceReferenceId: { type: 'STRING' },
    pageOrSection: { type: 'STRING' },
  },
  required: [valueKey, 'sourceReferenceId', 'pageOrSection'],
});

/**
 * Summarises one uploaded evidence document into qualitative findings.
 *
 * Temperature 0.2: the summary must stay close to the supplied text and must
 * never introduce numbers or conclusions of its own. The document can be long,
 * so the timeout sits between classification and the report summaries.
 *
 * The response schema is enforced here rather than only requested in prose —
 * the persisted `aiOutputJson` is read field-by-field by the UI and the combined
 * report, so a shape drift would surface as blank sections much later.
 */
export const EVIDENCE_DOCUMENT_SUMMARY_TASK: AiTask<DocumentSummaryOutputJson> = {
  name: 'evidence-document-summary',
  promptVersion: 'evidence-doc-summary-v3',
  model: 'gemini-2.5-flash',
  modelVersion: 'v1',
  temperature: 0.2,
  timeoutMs: 60_000,
  maxRetries: 1,
  systemPrompt: `You are an Evidence Document Analysis Assistant for a Community Needs Assessment Platform.

Your task is to create a qualitative Document Summary using only the supplied document metadata, extracted text, and chunk/section references.

IMPORTANT RULES:

1. Use only the supplied document content and metadata.
2. Do not calculate, modify, estimate, or invent Severity Score, Priority Score, KPI Score, confidence score, or any other numerical result.
3. Do not treat document statements as verified survey findings.
4. Use careful wording:
   - “Participants reported…”
   - “The field note states…”
   - “The document indicates…”
   - “The observation suggests…”
5. Do not claim improvement, decline, trend, cause, or impact unless it is explicitly stated in the document.
6. Do not expose PII, names, phone numbers, email addresses, or individual respondent details.
7. Do not invent facts, dates, locations, sources, recommendations, or references.
8. If information is missing, write the exact string supplied as DOCUMENT_DATA_UNAVAILABLE_TEXT in the input
9. Clearly state that this is qualitative evidence and does not alter survey-based Severity or Priority Scores.
10. Every supporting statement must include the supplied document reference ID and page/section reference when available.
11. Do not include testing/mock-document wording in the final summary unless it is explicitly required by the supplied document metadata.
12. Return valid JSON only. Do not return Markdown or additional explanation.` + LANGUAGE_RULE,
  responseSchema: {
    type: 'OBJECT',
    properties: {
      documentTitle: { type: 'STRING' },
      documentType: { type: 'STRING' },
      sourceReferenceId: { type: 'STRING' },
      collectionDate: { type: 'STRING' },
      linkedNeed: { type: 'STRING' },
      linkedDomain: { type: 'STRING' },
      linkedKpi: { type: 'STRING' },
      summary: { type: 'STRING' },
      keyFindings: { type: 'ARRAY', items: CITED_ITEM('finding') },
      themes: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            theme: { type: 'STRING' },
            description: { type: 'STRING' },
            sourceReferenceId: { type: 'STRING' },
            pageOrSection: { type: 'STRING' },
          },
          required: ['theme', 'description', 'sourceReferenceId', 'pageOrSection'],
        },
      },
      supportingStatements: { type: 'ARRAY', items: CITED_ITEM('statement') },
      risksOrConcerns: { type: 'ARRAY', items: CITED_ITEM('concern') },
      documentLimitations: { type: 'ARRAY', items: { type: 'STRING' } },
      evidenceNote: { type: 'STRING' },
    },
    required: [
      'documentTitle',
      'documentType',
      'sourceReferenceId',
      'summary',
      'keyFindings',
      'themes',
      'supportingStatements',
      'risksOrConcerns',
      'documentLimitations',
      'evidenceNote',
    ],
  },
};
