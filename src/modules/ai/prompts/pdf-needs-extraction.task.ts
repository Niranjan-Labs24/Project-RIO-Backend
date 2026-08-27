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
 *
 * The "STRICTLY FORBIDDEN TO ... SUMMARIZE" rule below is NOT in conflict with
 * RIO-AI-003, which summarises need statements. The two run at different
 * stages and mean different things:
 *
 *   this task     one PDF  -> N separate Needs, each kept whole. Summarising
 *                            here would MERGE distinct problems and lose needs.
 *   RIO-AI-003    each of those N Needs -> a shorter description of that ONE
 *                            need, reviewed and confirmed by a human.
 *
 * Extract first, keeping every detail; shorten afterwards, one need at a time.
 *
 * `statement`'s cap was 1,000 characters, which was both inconsistent with
 * needs.contract.ts's own 5,000-character limit on the same field AND below
 * RIO-AI-003's 1,500-character trigger threshold — so a PDF-imported Need
 * could never be summarised at all, making the client's "all entry points"
 * decision impossible to honour on this path. Raised to match the contract.
 */
export const PDF_NEEDS_EXTRACTION_TASK: AiTask<PdfNeedsExtractionResponse> = {
  name: 'pdf-needs-extraction',
  // v4: statement cap raised 1,000 -> 5,000 (see the note above).
  promptVersion: 'pdf-needs-extraction-v4',
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
- "statement": The detailed explanation for THAT SINGLE problem (max 5000 chars). Do not shorten or paraphrase to fit — keep the source's own detail for this one problem.
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
