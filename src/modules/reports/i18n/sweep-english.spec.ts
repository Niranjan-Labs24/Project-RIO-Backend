import { describe, expect, it } from 'vitest';
import { sweepRemainingEnglish } from './sweep-english';
import type { Translator } from './translate-content';
import type { ReportDoc } from '../report-doc';

// The final layer. Its job is a guarantee — nothing English survives it — so
// the tests are mostly about what it must NOT do while keeping that promise.

function fake(map: Record<string, string> = {}) {
  const seen: string[] = [];
  const translator: Translator = {
    async translate(text) {
      seen.push(text);
      const out = map[text] ?? `[ar] ${text}`;
      return { translatedText: out, unchanged: out === text };
    },
  };
  return { translator, seen };
}

const doc = (over: Partial<ReportDoc> = {}): ReportDoc => ({
  title: 'Individual Survey Report',
  headerBand: [{ label: 'Study Name', value: 'تقييم خدمات الرعاية الصحية' }],
  audit: [{ label: 'Status', value: 'released' }],
  sections: [],
  ...over,
});

const ALIASES = new Map([['health', 'الصحة']]);
const deps = (t: Translator) => ({ aliases: ALIASES, translator: t });

describe('sweepRemainingEnglish', () => {
  it('is a no-op in English and calls nothing', async () => {
    const { translator, seen } = fake();
    const d = doc();
    const out = await sweepRemainingEnglish(d, 'en', deps(translator));
    expect(out.doc).toBe(d);
    expect(seen).toEqual([]);
  });

  it('resolves from the catalogue before ever calling the translator', async () => {
    const { translator, seen } = fake();
    const out = await sweepRemainingEnglish(
      doc({ sections: [{ kind: 'note', heading: 'Data Quality', text: 'Severity' }] }),
      'ar',
      deps(translator),
    );
    // Both are catalogue entries, so neither should reach the provider.
    expect(seen).not.toContain('Data Quality');
    expect(seen).not.toContain('Severity');
    expect(out.stats.byCatalogue).toBeGreaterThan(0);
  });

  it('resolves master data from nameAr, not from the model', async () => {
    const { translator, seen } = fake();
    const out = await sweepRemainingEnglish(
      doc({ sections: [{ kind: 'table', heading: 'Domains', columns: ['Domain'], rows: [['Health']] }] }),
      'ar',
      deps(translator),
    );
    const table = out.doc.sections[0] as Extract<ReportDoc['sections'][number], { kind: 'table' }>;
    expect(table.rows[0]![0]).toBe('الصحة');
    expect(seen).not.toContain('Health');
    expect(out.stats.byMasterData).toBe(1);
  });

  it('sends only what the free layers could not resolve', async () => {
    const { translator, seen } = fake();
    await sweepRemainingEnglish(
      doc({
        sections: [
          { kind: 'note', heading: 'Observed Patterns', text: 'Need is concentrated, not uniform.' },
        ],
      }),
      'ar',
      deps(translator),
    );
    // The heading is a catalogue key; the sentence is novel.
    expect(seen).not.toContain('Observed Patterns');
    expect(seen).toContain('Need is concentrated, not uniform.');
  });

  it('REJECTS a translation that alters a figure', async () => {
    // The guard that makes it safe to hand deterministic sentences to a model
    // at all. These documents are approved and archived, and their numbers must
    // reconcile with the Priority Dashboard.
    const source = 'Needs Index = (33.72) / 1 = 33.72';
    const { translator } = fake({ [source]: 'مؤشر الاحتياجات = (33.7) / 1 = 33.7' });

    const out = await sweepRemainingEnglish(
      doc({ sections: [{ kind: 'list', heading: 'Calculation Basis', items: [source] }] }),
      'ar',
      deps(translator),
    );

    const list = out.doc.sections[0] as Extract<ReportDoc['sections'][number], { kind: 'list' }>;
    expect(list.items[0], 'a rounded figure must not reach the document').toBe(source);
    expect(out.stats.rejectedForDigits).toEqual([source]);
    // byTranslator counts the fixture's own strings too, so the meaningful
    // assertion is that this one is absent from the output, above.
  });

  it('accepts a translation that preserves every figure', async () => {
    const source = 'This survey assessed 1 of 10 domains.';
    const { translator } = fake({ [source]: 'قيّم هذا الاستبيان 1 من 10 مجالات.' });

    const out = await sweepRemainingEnglish(
      doc({ sections: [{ kind: 'list', heading: 'Coverage', items: [source] }] }),
      'ar',
      deps(translator),
    );

    const list = out.doc.sections[0] as Extract<ReportDoc['sections'][number], { kind: 'list' }>;
    expect(list.items[0]).toBe('قيّم هذا الاستبيان 1 من 10 مجالات.');
    expect(out.stats.rejectedForDigits).toEqual([]);
  });

  it('keeps codes, identifiers and versions in Latin script', async () => {
    const { translator, seen } = fake();
    const out = await sweepRemainingEnglish(
      doc({
        sections: [
          {
            kind: 'table',
            heading: 'Records',
            columns: ['Code'],
            rows: [['HLT-01'], ['SURVEY_ONLY'], ['v5.0'], ['NR-survey-d0d1270c93ae']],
          },
        ],
      }),
      'ar',
      deps(translator),
    );
    const table = out.doc.sections[0] as Extract<ReportDoc['sections'][number], { kind: 'table' }>;
    expect(table.rows.flat()).toEqual(['HLT-01', 'SURVEY_ONLY', 'v5.0', 'NR-survey-d0d1270c93ae']);
    for (const code of ['HLT-01', 'SURVEY_ONLY', 'v5.0', 'NR-survey-d0d1270c93ae']) {
      expect(seen, `sent the code "${code}"`).not.toContain(code);
    }
    // Only SURVEY_ONLY and NR-… reach the keep-list; "HLT-01" and "v5.0" carry
    // fewer than four Latin letters, so the has-English filter drops them one
    // step earlier. Either route leaves them untouched, which is what matters.
    expect(out.stats.keptAsIs).toBeGreaterThan(0);
  });

  it('reaches strings in every position, including nested columns', async () => {
    const { translator } = fake();
    const out = await sweepRemainingEnglish(
      doc({
        sections: [
          {
            kind: 'columns',
            children: [{ kind: 'note', heading: 'Nested heading here', text: 'Nested body text.' }],
          },
        ],
        chapters: [{ name: 'Chapter name here', summary: '3 rows', sections: [] }],
      }),
      'ar',
      deps(translator),
    );
    const cols = out.doc.sections[0] as Extract<ReportDoc['sections'][number], { kind: 'columns' }>;
    const note = cols.children[0] as Extract<ReportDoc['sections'][number], { kind: 'note' }>;
    expect(note.heading).toBe('[ar] Nested heading here');
    expect(note.text).toBe('[ar] Nested body text.');
    expect(out.doc.chapters![0]!.name).toBe('[ar] Chapter name here');
  });

  it('reports a provider failure instead of hiding it', async () => {
    const source = 'Some novel sentence here.';
    const { translator } = fake({ [source]: source });
    const out = await sweepRemainingEnglish(
      doc({ sections: [{ kind: 'note', heading: 'Notes', text: source }] }),
      'ar',
      deps(translator),
    );
    expect(out.stats.unresolved).toEqual([source]);
  });

  it('sends each distinct string once', async () => {
    const { translator, seen } = fake();
    const repeated = 'Repeated novel sentence.';
    await sweepRemainingEnglish(
      doc({
        sections: [
          { kind: 'note', heading: 'A', text: repeated },
          { kind: 'note', heading: 'B', text: repeated },
        ],
      }),
      'ar',
      deps(translator),
    );
    expect(seen.filter((x) => x === repeated)).toHaveLength(1);
  });
});
