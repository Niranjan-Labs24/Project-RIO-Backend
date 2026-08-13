import type { AiTask } from '../ai.task';

export interface ExtractedNeedItem {
  title: string;
  statement: string;
  village?: string;
  referenceId?: string;
}

export interface PdfNeedsExtractionResponse {
  needs: ExtractedNeedItem[];
}

/**
 * Extracts distinct community need items from an uploaded PDF text.
 */
export const PDF_NEEDS_EXTRACTION_TASK: AiTask<PdfNeedsExtractionResponse> = {
  name: 'pdf-needs-extraction',
  promptVersion: 'pdf-needs-extraction-v3',
  model: 'gemini-2.5-flash',
  modelVersion: 'v1',
  temperature: 0.0,
  timeoutMs: 60_000,
  maxRetries: 1,
  systemPrompt: `You are a strict, precise Community Needs Extraction Assistant for an NGO platform.
Your objective is to extract EVERY SINGLE individual problem, issue, requirement, or community need described in the PDF as a separate, independent item.

STRICT ATOMICITY RULES (NEVER COMBINE):
1. IT IS STRICTLY FORBIDDEN TO COMBINE, MERGE, OR SUMMARIZE MULTIPLE PROBLEMS INTO ONE NEED.
2. Every numbered item (e.g. 1., 2., 3., #1, #2), bullet point (*, -), paragraph header, or distinct problem mentioned in the text MUST become its own separate Need object in the "needs" array.
3. If the document describes N separate issues (e.g. 5 problems), you MUST output exactly N separate Need objects in the "needs" array.
4. Each Need object must contain ONLY its own specific problem description, NOT a list of multiple problems.

FIELD EXTRACTION FOR EACH NEED:
- "title": A short, specific title for THAT SINGLE problem (max 150 chars).
- "statement": The detailed explanation for THAT SINGLE problem (max 1000 chars).
- "village": The Governorate, Village, City, or Location associated with THAT problem if mentioned in the section or text. If not found, set to "".
- "referenceId": The Reference ID, Ref ID, Serial Number, or Code associated with THAT problem if mentioned in the section or text. If not found, set to "".

Return valid JSON adhering strictly to the JSON schema.`,
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
