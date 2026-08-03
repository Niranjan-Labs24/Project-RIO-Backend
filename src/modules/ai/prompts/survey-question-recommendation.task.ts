import type { AiTask } from '../ai.task';

export interface SurveyQuestionRecommendationResponse {
  recommendedQuestionIds?: string[];
  confidence?: number;
  reason?: string;
}

/**
 * Selects which Question Bank entries belong on a survey for a given Need.
 *
 * Temperature 0: the same Need against the same eligible-question list should
 * produce the same survey. The model only ever returns ids from the supplied
 * list, so this is a selection task, not a generative one.
 *
 * The caller degrades to every eligible question at confidence 0 if this fails,
 * which is safe — those are real Question Bank ids, not invented content.
 */
export const SURVEY_QUESTION_RECOMMENDATION_TASK: AiTask<SurveyQuestionRecommendationResponse> = {
  name: 'survey-question-recommendation',
  promptVersion: 'survey-question-recommendation-v1',
  model: 'gemini-2.5-flash',
  modelVersion: 'v1',
  temperature: 0,
  timeoutMs: 45_000,
  maxRetries: 1,
  systemPrompt: `You are a survey question recommendation assistant. You must recommend only question IDs from the provided eligible questions list. Do not create new question text. Do not edit question text. Return valid JSON only.`,
  responseSchema: {
    type: 'OBJECT',
    properties: {
      recommendedQuestionIds: { type: 'ARRAY', items: { type: 'STRING' } },
      confidence: { type: 'NUMBER' },
      reason: { type: 'STRING' },
    },
    required: ['recommendedQuestionIds', 'confidence', 'reason'],
  },
};
