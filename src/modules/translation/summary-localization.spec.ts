import { describe, expect, it, vi } from 'vitest';
import {
  cachedSummaryOutput,
  localizeSummaryOutput,
  summarySourceHash,
  type LocalizedOutputs,
} from './summary-localization';

// A stored priority summary, shaped like the real aiOutputJson.
const SOURCE = () => ({
  executiveSummary: 'Water access is the dominant need, with severity 63.8.',
  priorityExplanation: 'Health ranks second.',
  keyFindings: [
    {
      title: 'Wells out of service',
      domain: 'Water',
      kpi: 'Functional wells',
      severityScore: 71.2,
      confidence: 'HIGH',
      summary: 'Two of four wells were not working.',
    },
  ],
  evidenceSummary: [
    { evidenceTitle: 'Field report', sourceReferenceId: 'DOC-17', summary: 'Queues of two hours.' },
  ],
  draftNextSteps: ['Repair the wells'],
});

/** Arabic stand-in for any English segment, keeping its figures intact. */
function arabicFor(text: string): string {
  const figures = text.match(/\d+(?:\.\d+)?/g) ?? [];
  return ['نص عربي', ...figures].join(' ');
}

function fakeAi(answer: (batch: string[]) => string[] | Promise<string[]>) {
  const run = vi.fn(async (_task: unknown, prompt: string) => {
    const batch = JSON.parse(prompt) as string[];
    return { response: { translations: await answer(batch) }, raw: null };
  });
  return { ai: { run } as never, run };
}

describe('localizeSummaryOutput', () => {
  it('returns the summary untouched, with no AI call, when it is already in the requested language', async () => {
    const { ai, run } = fakeAi((b) => b.map(arabicFor));
    const source = SOURCE();
    const result = await localizeSummaryOutput(ai, {
      source,
      sourceLocale: 'ar',
      targetLocale: 'ar',
      stored: null,
    });
    expect(result).toEqual({ output: source, locale: 'ar', status: 'NATIVE' });
    expect(run).not.toHaveBeenCalled();
  });

  it('translates prose in one call and leaves enums, ids and numbers exactly as they were', async () => {
    const { ai, run } = fakeAi((b) => b.map(arabicFor));
    const result = await localizeSummaryOutput(ai, {
      source: SOURCE(),
      sourceLocale: 'en',
      targetLocale: 'ar',
      stored: null,
    });

    expect(result.status).toBe('TRANSLATED');
    expect(result.locale).toBe('ar');
    expect(run).toHaveBeenCalledTimes(1);

    const out = result.output as ReturnType<typeof SOURCE>;
    expect(out.executiveSummary).toBe('نص عربي 63.8');
    expect(out.keyFindings[0]!.summary).toBe('نص عربي');
    expect(out.draftNextSteps).toEqual(['نص عربي']);
    // Protected: enum, id, and numbers are never sent and never change.
    expect(out.keyFindings[0]!.confidence).toBe('HIGH');
    expect(out.keyFindings[0]!.severityScore).toBe(71.2);
    expect(out.evidenceSummary[0]!.sourceReferenceId).toBe('DOC-17');

    const sent = JSON.parse(run.mock.calls[0]![1] as string) as string[];
    expect(sent).not.toContain('HIGH');
    expect(sent).not.toContain('DOC-17');
  });

  it('returns a persistable translation keyed to the source it was made from', async () => {
    const { ai } = fakeAi((b) => b.map(arabicFor));
    const source = SOURCE();
    const result = await localizeSummaryOutput(ai, {
      source,
      sourceLocale: 'en',
      targetLocale: 'ar',
      stored: null,
    });
    expect(result.toPersist?.ar?.sourceHash).toBe(summarySourceHash(source));
    expect(result.toPersist?.ar?.output).toEqual(result.output);
  });

  it('serves a persisted translation without calling the provider', async () => {
    const { ai, run } = fakeAi((b) => b.map(arabicFor));
    const source = SOURCE();
    const stored: LocalizedOutputs = {
      ar: { sourceHash: summarySourceHash(source), output: { executiveSummary: 'مخزّن' } },
    };
    const result = await localizeSummaryOutput(ai, {
      source,
      sourceLocale: 'en',
      targetLocale: 'ar',
      stored,
    });
    expect(result).toEqual({
      output: { executiveSummary: 'مخزّن' },
      locale: 'ar',
      status: 'CACHED',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('re-translates when the officer edited the summary after it was translated', async () => {
    const { ai, run } = fakeAi((b) => b.map(arabicFor));
    const stored: LocalizedOutputs = {
      ar: { sourceHash: summarySourceHash({ executiveSummary: 'the old text' }), output: {} },
    };
    const result = await localizeSummaryOutput(ai, {
      source: SOURCE(),
      sourceLocale: 'en',
      targetLocale: 'ar',
      stored,
    });
    expect(result.status).toBe('TRANSLATED');
    expect(run).toHaveBeenCalled();
  });

  it('retries only the rejected segments, and persists once every one passes', async () => {
    let call = 0;
    const { ai, run } = fakeAi((b) => {
      call++;
      // First pass leaves English in one segment; the retry gets it right.
      return b.map((t) =>
        call === 1 && t.startsWith('Health') ? 'الصحة ranks second' : arabicFor(t),
      );
    });
    const result = await localizeSummaryOutput(ai, {
      source: SOURCE(),
      sourceLocale: 'en',
      targetLocale: 'ar',
      stored: null,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(JSON.parse(run.mock.calls[1]![1] as string)).toEqual(['Health ranks second.']);
    expect(result.status).toBe('TRANSLATED');
    expect(result.toPersist).toBeDefined();
  });

  it('keeps the source for a segment that never passes, and does NOT persist', async () => {
    const { ai } = fakeAi((b) =>
      b.map((t) => (t.includes('63.8') ? 'نص بدون أرقام' : arabicFor(t))),
    );
    const result = await localizeSummaryOutput(ai, {
      source: SOURCE(),
      sourceLocale: 'en',
      targetLocale: 'ar',
      stored: null,
    });
    expect(result.status).toBe('PARTIAL');
    expect(result.toPersist).toBeUndefined();
    const out = result.output as ReturnType<typeof SOURCE>;
    // The figure-changing answer was refused; the source sentence stands.
    expect(out.executiveSummary).toBe(SOURCE().executiveSummary);
    expect(out.priorityExplanation).toBe('نص عربي');
  });

  it('discards a reply whose length does not match the segments sent', async () => {
    const { ai } = fakeAi((b) => b.slice(1).map(arabicFor));
    const result = await localizeSummaryOutput(ai, {
      source: SOURCE(),
      sourceLocale: 'en',
      targetLocale: 'ar',
      stored: null,
    });
    expect(result.status).toBe('PARTIAL');
    expect(result.output).toEqual(SOURCE());
  });

  it('returns the source, labelled with its real language, when the provider is down', async () => {
    const { ai } = fakeAi(() => {
      throw new Error('AI_UNAVAILABLE');
    });
    const source = SOURCE();
    const result = await localizeSummaryOutput(ai, {
      source,
      sourceLocale: 'en',
      targetLocale: 'ar',
      stored: null,
    });
    expect(result).toEqual({ output: source, locale: 'en', status: 'FAILED' });
  });

  it('translates an Arabic summary into English for an English viewer', async () => {
    const { ai } = fakeAi((b) => b.map(() => 'English text'));
    const result = await localizeSummaryOutput(ai, {
      source: { executiveSummary: 'الحاجة إلى المياه هي الأولى' },
      sourceLocale: 'ar',
      targetLocale: 'en',
      stored: null,
    });
    expect(result.status).toBe('TRANSLATED');
    expect(result.output).toEqual({ executiveSummary: 'English text' });
  });
});

describe('cachedSummaryOutput', () => {
  it('never calls anything and returns null when no current translation exists', () => {
    expect(
      cachedSummaryOutput({
        source: SOURCE(),
        sourceLocale: 'en',
        targetLocale: 'ar',
        stored: null,
      }),
    ).toBeNull();
  });

  it('returns the persisted translation while it still matches the source', () => {
    const source = SOURCE();
    const stored: LocalizedOutputs = {
      ar: { sourceHash: summarySourceHash(source), output: { a: 'ب' } },
    };
    expect(
      cachedSummaryOutput({ source, sourceLocale: 'en', targetLocale: 'ar', stored })?.output,
    ).toEqual({
      a: 'ب',
    });
  });
});
