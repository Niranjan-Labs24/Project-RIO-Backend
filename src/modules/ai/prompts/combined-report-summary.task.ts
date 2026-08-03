import type { AiTask } from '../ai.task';
import type { CombinedReportOutputJson } from '../../reports/combined-report-summary.service';

/**
 * Merges one score-based summary with the selected evidence-document summaries
 * into a single report narrative.
 *
 * This is the largest prompt in the platform — a whole score summary plus every
 * selected document summary — hence the longest timeout. Temperature 0.2: the
 * quantitative half must be restated verbatim, never recomputed.
 *
 * The schema is enforced because the persisted output is read section-by-section
 * by the report viewer and the exporters; a missing `scoreBasedFindings` would
 * otherwise surface as a silently blank report section.
 */
export const COMBINED_REPORT_SUMMARY_TASK: AiTask<CombinedReportOutputJson> = {
  name: 'combined-report-summary',
  promptVersion: 'combined-report-summary-v1',
  model: 'gemini-2.5-flash',
  modelVersion: 'v1',
  temperature: 0.2,
  timeoutMs: 120_000,
  maxRetries: 1,
  systemPrompt: `You are an expert humanitarian policy analyst compiling a unified Combined Assessment Report.
RULES:
1. STRICTLY separate quantitative Score-Based Findings and qualitative Document-Based Evidence.
2. NEVER change, recalculate, or invent scoring numbers or priority levels.
3. NEVER present evidence document statements as quantitative scoring outputs.
4. Return valid JSON matching the required sections.`,
  responseSchema: {
    type: 'OBJECT',
    properties: {
      header: {
        type: 'OBJECT',
        properties: {
          studyName: { type: 'STRING' },
          entityName: { type: 'STRING' },
          methodologyVersion: { type: 'STRING' },
          cycleNumber: { type: 'NUMBER' },
          generatedAt: { type: 'STRING' },
        },
        required: ['studyName', 'entityName', 'methodologyVersion', 'cycleNumber', 'generatedAt'],
      },
      geography: {
        type: 'OBJECT',
        properties: {
          region: { type: 'STRING' },
          governorate: { type: 'STRING' },
        },
        required: ['region', 'governorate'],
      },
      executiveSummary: { type: 'STRING' },
      scoreBasedFindings: {
        type: 'OBJECT',
        properties: {
          overallSeverityScore: { type: 'NUMBER' },
          priorityScore: { type: 'NUMBER' },
          priorityStatus: { type: 'STRING' },
          topDomainsOrKpis: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { name: { type: 'STRING' }, score: { type: 'NUMBER' } },
              required: ['name', 'score'],
            },
          },
          confidenceDataQualityNote: { type: 'STRING' },
        },
        required: [
          'overallSeverityScore',
          'priorityScore',
          'priorityStatus',
          'topDomainsOrKpis',
          'confidenceDataQualityNote',
        ],
      },
      documentBasedEvidence: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            documentTitle: { type: 'STRING' },
            sourceReferenceId: { type: 'STRING' },
            documentType: { type: 'STRING' },
            linkedNeedOrDomain: { type: 'STRING' },
            keyEvidenceFinding: { type: 'STRING' },
            sourcePageOrSection: { type: 'STRING' },
          },
          required: [
            'documentTitle',
            'sourceReferenceId',
            'documentType',
            'linkedNeedOrDomain',
            'keyEvidenceFinding',
          ],
        },
      },
      domainKpiResults: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            domainName: { type: 'STRING' },
            severity: { type: 'NUMBER' },
            performance: { type: 'NUMBER' },
            weight: { type: 'NUMBER' },
            confidence: { type: 'STRING' },
            typeLabel: { type: 'STRING' },
          },
          required: ['domainName', 'severity', 'performance', 'weight', 'confidence', 'typeLabel'],
        },
      },
      responseQuality: {
        type: 'OBJECT',
        properties: {
          validResponseCount: { type: 'NUMBER' },
          confidenceLevel: { type: 'STRING' },
          dontKnowRate: { type: 'NUMBER' },
          lowConfidenceReason: { type: 'STRING' },
        },
        required: ['validResponseCount', 'confidenceLevel', 'dontKnowRate'],
      },
      recommendations: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            intervention: { type: 'STRING' },
            priority: { type: 'STRING' },
            statusLabel: { type: 'STRING' },
          },
          required: ['intervention', 'priority', 'statusLabel'],
        },
      },
      auditMetadata: {
        type: 'OBJECT',
        properties: {
          scoreSummaryId: { type: 'STRING' },
          includedDocumentSummaryIds: { type: 'ARRAY', items: { type: 'STRING' } },
          aiModel: { type: 'STRING' },
          promptVersion: { type: 'STRING' },
          generatedTimestamp: { type: 'STRING' },
        },
        required: [
          'scoreSummaryId',
          'includedDocumentSummaryIds',
          'aiModel',
          'promptVersion',
          'generatedTimestamp',
        ],
      },
    },
    required: [
      'header',
      'geography',
      'executiveSummary',
      'scoreBasedFindings',
      'documentBasedEvidence',
      'domainKpiResults',
      'responseQuality',
      'recommendations',
      'auditMetadata',
    ],
  },
};
