import { describe, it, expect } from 'vitest';
import { AiClassificationDeclinedError, classifyNeedWithAi } from './classification.ai';
import { NEED_CLASSIFICATION_TASK } from '../ai/prompts/need-classification.task';
import type { ClassificationCandidate } from './classification.placeholder';

const CANDIDATES: ClassificationCandidate[] = [
  { domainCode: 'HLT', domainName: 'Health', subDomains: [{ code: 'HLT-PHC', name: 'Primary Healthcare Access' }] },
];

const SUBJECT = { statement: 'No clinic within 40km.', village: ['Al-Jumum North'] };

/** Minimal AiService stand-in: returns whatever the test hands it. */
function fakeAi(response: Record<string, unknown>) {
  return { run: async () => ({ response }) } as never;
}

describe('classifyNeedWithAi', () => {
  it('passes a reported confidence through unchanged', async () => {
    const result = await classifyNeedWithAi(
      fakeAi({ classified: true, domain: 'Health', subDomain: 'Primary Healthcare Access', confidence: 0.83, rationale: 'r' }),
      SUBJECT,
      'redacted',
      CANDIDATES,
    );
    expect(result.confidence).toBe(0.83);
  });

  it('keeps a genuine zero confidence as 0, not null', async () => {
    const result = await classifyNeedWithAi(
      fakeAi({ classified: true, domain: 'Health', subDomain: 'Primary Healthcare Access', confidence: 0, rationale: 'r' }),
      SUBJECT,
      'redacted',
      CANDIDATES,
    );
    expect(result.confidence).toBe(0);
  });

  it('returns null — NOT 0 — when the model omits confidence', async () => {
    // The regression this guards: `?? 0` made a good classification render as
    // the worst possible one, indistinguishable from an AI decline.
    const result = await classifyNeedWithAi(
      fakeAi({ classified: true, domain: 'Health', subDomain: 'Primary Healthcare Access', rationale: 'r' }),
      SUBJECT,
      'redacted',
      CANDIDATES,
    );
    expect(result.confidence).toBeNull();
  });

  it('returns null when the model sends a non-numeric confidence', async () => {
    const result = await classifyNeedWithAi(
      fakeAi({ classified: true, domain: 'Health', subDomain: 'Primary Healthcare Access', confidence: 'high', rationale: 'r' }),
      SUBJECT,
      'redacted',
      CANDIDATES,
    );
    expect(result.confidence).toBeNull();
  });

  it('still throws AiClassificationDeclinedError when the model declines', async () => {
    await expect(
      classifyNeedWithAi(fakeAi({ classified: false, rationale: 'too vague' }), SUBJECT, 'redacted', CANDIDATES),
    ).rejects.toBeInstanceOf(AiClassificationDeclinedError);
  });
});

describe('NEED_CLASSIFICATION_TASK', () => {
  it('requires confidence in its response schema', () => {
    // Leaving it optional is what let a successful classification arrive with
    // no confidence at all in the first place.
    expect(NEED_CLASSIFICATION_TASK.responseSchema?.required).toContain('confidence');
  });

  it('leaves domain/subDomain optional so a decline can omit them', () => {
    expect(NEED_CLASSIFICATION_TASK.responseSchema?.required).not.toContain('domain');
    expect(NEED_CLASSIFICATION_TASK.responseSchema?.required).not.toContain('subDomain');
  });
});
