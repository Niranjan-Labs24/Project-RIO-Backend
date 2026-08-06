import { describe, expect, it } from 'vitest';
import { promptHashOf, type AiTask } from './ai.task';
import { NEED_CLASSIFICATION_TASK } from './prompts/need-classification.task';
import { EVIDENCE_DOCUMENT_SUMMARY_TASK } from './prompts/evidence-document-summary.task';
import { COMBINED_REPORT_SUMMARY_TASK } from './prompts/combined-report-summary.task';
import { SURVEY_QUESTION_RECOMMENDATION_TASK } from './prompts/survey-question-recommendation.task';
import { SCORE_SUMMARY_TASKS } from './prompts/score-summary.task';

// Every AI use case in the platform. Kept as one list so a newly added task
// cannot skip the guarantees below.
const ALL_TASKS: AiTask<unknown>[] = [
  NEED_CLASSIFICATION_TASK,
  EVIDENCE_DOCUMENT_SUMMARY_TASK,
  COMBINED_REPORT_SUMMARY_TASK,
  SURVEY_QUESTION_RECOMMENDATION_TASK,
  ...Object.values(SCORE_SUMMARY_TASKS),
];

describe('AI task declarations', () => {
  it('covers every AI use case with a distinct name and prompt version', () => {
    const names = ALL_TASKS.map((t) => t.name);
    const versions = ALL_TASKS.map((t) => t.promptVersion);
    expect(new Set(names).size).toBe(ALL_TASKS.length);
    expect(new Set(versions).size).toBe(ALL_TASKS.length);
  });

  // Without a schema the model is only asked for JSON in prose, and a shape
  // drift is discovered at JSON.parse time or, worse, as a blank report section.
  it('enforces a response schema on every task', () => {
    for (const task of ALL_TASKS) {
      expect(task.responseSchema, task.name).toBeTruthy();
      expect(Object.keys(task.responseSchema).length, task.name).toBeGreaterThan(0);
    }
  });

  it('gives every task its own model settings within sane bounds', () => {
    for (const task of ALL_TASKS) {
      expect(task.model, task.name).toBeTruthy();
      expect(task.temperature, task.name).toBeGreaterThanOrEqual(0);
      expect(task.temperature, task.name).toBeLessThanOrEqual(1);
      expect(task.timeoutMs, task.name).toBeGreaterThan(0);
      expect(task.maxRetries, task.name).toBeGreaterThanOrEqual(0);
    }
  });

  // Classification feeds a stored AiDecision a human then reviews; the same
  // statement must not classify differently between runs.
  it('runs classification and question selection deterministically', () => {
    expect(NEED_CLASSIFICATION_TASK.temperature).toBe(0);
    expect(SURVEY_QUESTION_RECOMMENDATION_TASK.temperature).toBe(0);
  });

  // A short classification prompt and a whole-region report summary must not
  // share one timeout.
  it('allows the larger summary tasks more time than classification', () => {
    expect(COMBINED_REPORT_SUMMARY_TASK.timeoutMs).toBeGreaterThan(
      NEED_CLASSIFICATION_TASK.timeoutMs,
    );
    expect(SCORE_SUMMARY_TASKS.REGION.timeoutMs).toBeGreaterThan(
      NEED_CLASSIFICATION_TASK.timeoutMs,
    );
  });

  describe('promptHashOf', () => {
    it('is stable for the same prompt text', () => {
      expect(promptHashOf(NEED_CLASSIFICATION_TASK)).toBe(
        promptHashOf(NEED_CLASSIFICATION_TASK),
      );
    });

    // This is the point of storing the hash: an edited prompt is detectable
    // even when the version string was not bumped.
    it('changes when the prompt text changes', () => {
      const edited: AiTask<unknown> = {
        ...NEED_CLASSIFICATION_TASK,
        systemPrompt: `${NEED_CLASSIFICATION_TASK.systemPrompt} Additional rule.`,
      };
      expect(promptHashOf(edited)).not.toBe(promptHashOf(NEED_CLASSIFICATION_TASK));
    });

    it('differs between tasks', () => {
      const hashes = ALL_TASKS.map(promptHashOf);
      expect(new Set(hashes).size).toBe(ALL_TASKS.length);
    });
  });
});
