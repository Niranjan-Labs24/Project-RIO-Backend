import type { AiTask } from '../ai.task';

export interface ExtractedSurveyNeedItem {
  title: string;
  statement: string;
  village?: string;
  referenceId?: string;
}

export interface SurveyNeedsExtractionResponse {
  needs: ExtractedSurveyNeedItem[];
}

/**
 * AI Task to analyze survey results, scores, ratings, and findings,
 * and extract all distinct community Needs implied by low scores or reported issues.
 */
export const SURVEY_NEEDS_EXTRACTION_TASK: AiTask<SurveyNeedsExtractionResponse> = {
  name: 'survey-needs-extraction',
  promptVersion: 'survey-needs-extraction-v1',
  model: 'gemini-2.5-flash',
  modelVersion: 'v1',
  temperature: 0.0,
  timeoutMs: 60_000,
  maxRetries: 1,
  systemPrompt: `You are a Survey Results & Community Needs Analysis Assistant for an NGO platform.
Given text extracted from a survey results document (which may include survey metrics, low KPI scores, severity ratings, assessment findings, respondent feedback, or field survey data), your objective is to analyze the data and extract EVERY distinct community need or problem indicated by the survey results.

CRITICAL RULES:
1. FOCUS ON LOW SCORES & SEVERE GAPS: Look for survey metrics, low ratings, negative respondent feedback, or explicit problems mentioned in the survey data.
2. DO NOT MERGE OR CLUB DISTINCT PROBLEMS: If the survey results indicate 4 distinct problems (e.g. water shortage, lack of electricity, unpaved roads, shortage of clinics), you MUST output 4 separate Need objects in the "needs" array.
3. For each extracted Need:
   - "title": A clear, concise title summarizing that specific community problem (max 150 chars).
   - "statement": A detailed description explaining the problem, incorporating any relevant survey scores, percentages, or findings mentioned in the document (max 1000 chars).
   - "village": The Governorate, Village, City, or Location associated with that survey finding if mentioned. Set to "" if not found.
   - "referenceId": The Survey Code, Reference ID, Serial Tag, or Question ID associated with that finding if mentioned. Set to "" if not found.
4. Do not invent or fabricate findings not present in the survey document.
5. Return valid JSON adhering strictly to the JSON schema provided.`,
  responseSchema: {
    type: 'OBJECT',
    properties: {
      needs: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING' },
            statement: { type: 'STRING' },
            village: { type: 'STRING' },
            referenceId: { type: 'STRING' },
          },
          required: ['title', 'statement'],
        },
      },
    },
    required: ['needs'],
  },
};
