import { describe, expect, it, vi } from 'vitest';
import { translateReportContent, type Translator } from './translate-content';

// A translator that records what it was asked for, so the tests can assert on
// the CALLS as much as the output — this is the only part of the export that
// costs money, and what it declines to send is the point.
function fake(overrides: { fail?: boolean; delayMs?: number } = {}) {
  const seen: string[] = [];
  let inFlight = 0;
  let peak = 0;

  const translator: Translator = {
    async translate(text) {
      seen.push(text);
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (overrides.delayMs) await new Promise((r) => setTimeout(r, overrides.delayMs));
      inFlight--;
      // TranslationService returns the SOURCE text on provider failure — it
      // never throws — so that is what a failure looks like here too.
      if (overrides.fail) return { translatedText: text, unchanged: true };
      return { translatedText: `[ar] ${text}`, unchanged: false };
    },
  };
  return { translator, seen, peak: () => peak };
}

const CONTENT = () => ({
  aiSummary: {
    executiveSummary: 'Water access is the dominant need in this village.',
    keyFindings: 'Two of four wells were non-functional at the time of the visit.',
    recommendations: ['Repair the two non-functional wells', 'Add a second clinic shift'],
    // Deliberately NOT in PROSE_PATHS at this nesting — proves the walker
    // follows declared paths rather than sweeping the object.
    promptVersion: 'v4',
  },
  qualitativeEvidence: [{ theme: 'Water', summary: 'Residents queue for two hours.' }],
  reviewerNotes: [{ author: 'R. Reviewer', note: 'Confirmed with the field team.', at: '2026-09-01' }],
  // Deterministic prose. Must never be sent: every distinct figure would be a
  // new permanent cache entry, and a model could rewrite the numbers.
  coverageStatement: "This survey assessed 5 of the methodology's 9 domains.",
  severity: { overallVillageNeedsIndex: 63.8, severityBand: 'CRITICAL' },
  header: { studyName: 'Ad-Dilam Baseline', methodologyVersion: 'v5.0' },
});

describe('translateReportContent', () => {
  it('does nothing for English and makes no calls', async () => {
    const { translator, seen } = fake();
    const content = CONTENT();
    const out = await translateReportContent(content, 'en', translator);

    expect(seen).toEqual([]);
    expect(out.content).toBe(content);
    expect(out.requested).toBe(0);
  });

  it('translates only the declared prose fields', async () => {
    const { translator, seen } = fake();
    const out = await translateReportContent(CONTENT(), 'ar', translator);
    const ai = out.content.aiSummary as Record<string, unknown>;

    expect(ai.executiveSummary).toBe('[ar] Water access is the dominant need in this village.');
    expect(ai.recommendations).toEqual([
      '[ar] Repair the two non-functional wells',
      '[ar] Add a second clinic shift',
    ]);
    expect((out.content.qualitativeEvidence as Array<Record<string, unknown>>)[0]!.summary).toBe(
      '[ar] Residents queue for two hours.',
    );
    expect((out.content.reviewerNotes as Array<Record<string, unknown>>)[0]!.note).toBe(
      '[ar] Confirmed with the field team.',
    );

    // The undeclared neighbours are untouched, including the one sitting inside
    // a translated object.
    expect(ai.promptVersion).toBe('v4');
    expect(out.content.coverageStatement).toBe(CONTENT().coverageStatement);
    expect(seen).not.toContain(CONTENT().coverageStatement);
  });

  it('never sends figures, bands, versions or study names', async () => {
    const { translator, seen } = fake();
    await translateReportContent(CONTENT(), 'ar', translator);

    for (const forbidden of ['CRITICAL', 'v5.0', 'v4', 'Ad-Dilam Baseline', '63.8']) {
      expect(seen, `sent "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('leaves the caller content untouched', async () => {
    const { translator } = fake();
    const content = CONTENT();
    const before = structuredClone(content);

    const out = await translateReportContent(content, 'ar', translator);

    // A stored report's content records what was generated. Downloading it in
    // Arabic must not rewrite it.
    expect(content).toEqual(before);
    expect(out.content).not.toBe(content);
  });

  it('sends each distinct string once, however often it appears', async () => {
    const { translator, seen } = fake();
    const repeated = 'Repair the two non-functional wells';
    const out = await translateReportContent(
      {
        aiSummary: { recommendations: [repeated, repeated, 'Add a second clinic shift'] },
        recommendations: [repeated],
      },
      'ar',
      translator,
    );

    expect(seen.filter((s) => s === repeated)).toHaveLength(1);
    expect(out.requested).toBe(2);
    // …and every occurrence still got the translation.
    expect((out.content.recommendations as string[])[0]).toBe(`[ar] ${repeated}`);
    expect((out.content.aiSummary as { recommendations: string[] }).recommendations[1]).toBe(
      `[ar] ${repeated}`,
    );
  });

  it('bounds concurrency', async () => {
    const { translator, peak } = fake({ delayMs: 5 });
    const recommendations = Array.from({ length: 40 }, (_, i) => `Recommendation number ${i}`);

    await translateReportContent({ recommendations }, 'ar', translator, { concurrency: 4 });

    // Unbounded, a first-generation report fires every miss at the provider at
    // once.
    expect(peak()).toBeLessThanOrEqual(4);
  });

  it('reports a degraded export rather than failing it', async () => {
    const { translator } = fake({ fail: true });
    const out = await translateReportContent(CONTENT(), 'ar', translator);

    // TranslationService returns source text when the provider is down. The
    // export still succeeds — but half-English output must be countable, not
    // silent.
    expect(out.failed).toBe(out.requested);
    expect(out.requested).toBeGreaterThan(0);
    expect((out.content.aiSummary as Record<string, unknown>).executiveSummary).toBe(
      CONTENT().aiSummary.executiveSummary,
    );
  });

  it('skips strings with nothing to translate', async () => {
    const { translator, seen } = fake();
    await translateReportContent(
      {
        aiSummary: { executiveSummary: '', keyFindings: '—' },
        recommendations: ['CRITICAL', 'RPT01', '2026-09-01T10:30:00.000Z', 'الرياض', '42'],
      },
      'ar',
      translator,
    );

    expect(seen).toEqual([]);
  });

  it('translates a string that MIXES English with an Arabic value', async () => {
    // The regression this file exists for. The report composer glues a fixed
    // English template to an Arabic study name, producing a string that is
    // majority-Arabic by character count but whose English half is fully
    // untranslated. An earlier "contains Arabic -> skip" rule dropped every one
    // of these, and it was invisible beside a sibling field that happened to be
    // pure English and translated fine.
    const { translator, seen } = fake();
    const mixed =
      "This survey, part of the 'تقييم خدمات الرعاية الصحية الأولية' assessment in " +
      'Ad-Dawadmi, reveals a MEDIUM overall need severity score of 33.72.';

    const out = await translateReportContent(
      { aiSummary: { executiveSummary: mixed } },
      'ar',
      translator,
    );

    expect(seen, 'mixed-script prose must still be sent').toEqual([mixed]);
    expect((out.content.aiSummary as { executiveSummary: string }).executiveSummary).toBe(
      `[ar] ${mixed}`,
    );
  });

  it('does not re-send text that is already Arabic', async () => {
    // A report generated from Arabic-authored evidence, or a re-export.
    const { translator, seen } = fake();
    const out = await translateReportContent(
      { recommendations: ['إصلاح البئرين المعطلين'] },
      'ar',
      translator,
    );

    expect(seen).toEqual([]);
    expect((out.content.recommendations as string[])[0]).toBe('إصلاح البئرين المعطلين');
  });

  it('survives content that does not match the expected shape', async () => {
    const { translator } = fake();
    // Placeholder types, older stored reports and partial content all reach
    // here; a path that does not resolve must be a no-op, not a crash.
    const out = await translateReportContent(
      { aiSummary: 'not an object', recommendations: 'not an array', qualitativeEvidence: null },
      'ar',
      translator,
    );

    expect(out.requested).toBe(0);
  });

  it('is deterministic about which strings it sends', async () => {
    const a = fake();
    const b = fake();
    await translateReportContent(CONTENT(), 'ar', a.translator, { concurrency: 1 });
    await translateReportContent(CONTENT(), 'ar', b.translator, { concurrency: 1 });

    expect(a.seen).toEqual(b.seen);
  });
});
