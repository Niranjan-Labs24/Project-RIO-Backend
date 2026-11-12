import { describe, expect, it } from 'vitest';
import { NEED_CLASSIFICATION_TASK, needClassificationTaskFor } from './need-classification.task';

describe('needClassificationTaskFor (UAT GEN-15)', () => {
  it('keeps the English task unchanged', () => {
    expect(needClassificationTaskFor('en')).toBe(NEED_CLASSIFICATION_TASK);
  });

  it('asks for an Arabic rationale while keeping domain names and keys as listed', () => {
    const ar = needClassificationTaskFor('ar');
    expect(ar.systemPrompt).toContain('Write the rationale in Modern Standard Arabic');
    expect(ar.systemPrompt).toContain('never translate them');
    expect(ar.promptVersion).not.toBe(NEED_CLASSIFICATION_TASK.promptVersion);
  });

  it('never lets the rationale talk about translating the statement', () => {
    expect(NEED_CLASSIFICATION_TASK.systemPrompt).toContain('never describe translating the statement');
  });
});
