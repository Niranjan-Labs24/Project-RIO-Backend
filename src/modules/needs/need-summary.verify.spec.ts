import { describe, it, expect } from 'vitest';
import { verifySummary, encodeWarnings, decodeWarnings } from './need-summary.verify';

/**
 * RIO-AI-003 AC 5 acceptance evidence.
 *
 * The AC — "preserves key facts (location, need type, affected group) without
 * introducing unsupported claims" — cannot be signed off by reading prose. This
 * file is the evidence: a fixture set of real-shaped need statements, each
 * paired with a GOOD summary that must pass clean and a BAD one that must be
 * caught, in English and Arabic.
 *
 * What this proves and what it does not:
 *   - it proves the CHECKS work, deterministically and without a model call;
 *   - it does not prove Gemini always writes good summaries. Nothing offline
 *     can. That is why AC 3's human confirmation gate exists, and why these
 *     warnings are surfaced to the reviewer rather than used to auto-reject.
 */

interface Fixture {
  name: string;
  source: string;
  /** What a correct summary must keep: location, need type, affected group. */
  facts: string[];
  good: string;
  /** The failure this fixture exists to catch, and the summary that shows it. */
  bad: { summary: string; expect: string };
}

const FIXTURES: Fixture[] = [
  {
    name: 'water — village, group and duration all present',
    source:
      'Households in Al-Jumum North have reported that the piped water supply is available only two days per week. Women and children walk to a private tanker point on the other days. Residents say the situation has continued since the last dry season.',
    facts: ['Al-Jumum North', 'women and children', 'two days per week'],
    good: 'Piped water in Al-Jumum North is available only two days per week; on other days women and children collect water from a private tanker point. Residents report this has continued since the last dry season.',
    bad: {
      summary: 'Piped water in Al-Jumum North reaches about 320 households only two days per week, affecting women and children.',
      expect: 'NUMBER_INVENTED',
    },
  },
  {
    name: 'health — affected group must survive the cut',
    source:
      'The nearest functioning health facility for Al-Daer Central is roughly 40 minutes away by road. Elderly residents and people with disabilities describe the journey as the main reason they defer care. There is no scheduled community transport.',
    facts: ['Al-Daer Central', 'elderly residents and people with disabilities', '40 minutes'],
    good: 'For Al-Daer Central the nearest functioning health facility is roughly 40 minutes away by road, with no scheduled community transport. Elderly residents and people with disabilities defer care because of the journey.',
    bad: {
      summary: 'The nearest health facility for Al-Daer Central is roughly 40 minutes away by road and there is no scheduled community transport.',
      expect: 'FACT_DROPPED',
    },
  },
  {
    name: 'education — place name must not be dropped',
    source:
      'Families in Al-Makhwah Hills report that secondary-age girls stop attending school after the local intermediate stage because the nearest secondary school requires a bus journey that is not provided.',
    facts: ['Al-Makhwah Hills', 'secondary-age girls'],
    good: 'In Al-Makhwah Hills, secondary-age girls stop attending after the intermediate stage because the nearest secondary school requires a bus journey that is not provided.',
    bad: {
      summary: 'Secondary-age girls stop attending after the intermediate stage because the nearest secondary school requires a bus journey that is not provided.',
      expect: 'FACT_DROPPED',
    },
  },
  {
    name: 'livelihood — a fabricated proportion is the classic failure',
    source:
      'Smallholder farmers around Bani Yas say they sell produce at the roadside because the nearest wholesale market is not reachable without a vehicle. Several described losing part of the harvest to spoilage.',
    facts: ['Bani Yas', 'smallholder farmers'],
    good: 'Smallholder farmers around Bani Yas sell produce at the roadside because the nearest wholesale market is not reachable without a vehicle, and several report losing part of the harvest to spoilage.',
    bad: {
      summary: 'Around 60% of smallholder farmers around Bani Yas sell at the roadside and lose harvest to spoilage.',
      expect: 'NUMBER_INVENTED',
    },
  },
  {
    name: 'infrastructure — model vouches for a place that is not in the source',
    source:
      'Residents of Al Wathba report that the unpaved access road becomes impassable after rain, cutting off the settlement for one or two days at a time.',
    facts: ['Al Wathba', 'one or two days'],
    good: 'The unpaved access road to Al Wathba becomes impassable after rain, cutting off the settlement for one or two days at a time.',
    bad: {
      summary: 'The unpaved access road to Al Falah becomes impassable after rain, cutting the settlement off for one or two days.',
      // The model claims it preserved "Al Wathba" while writing "Al Falah".
      expect: 'FACT_DROPPED',
    },
  },
  {
    name: 'arabic — same checks must hold in Arabic',
    source:
      'تفيد الأسر في الجموم الشمالية بأن إمدادات المياه متاحة يومين فقط في الأسبوع، وتضطر النساء والأطفال إلى جلب المياه من نقطة صهاريج خاصة في بقية الأيام.',
    facts: ['الجموم الشمالية', 'النساء والأطفال'],
    good: 'إمدادات المياه في الجموم الشمالية متاحة يومين فقط في الأسبوع، ويقوم النساء والأطفال بجلب المياه من نقطة صهاريج خاصة في بقية الأيام.',
    bad: {
      summary: 'إمدادات المياه في الجموم الشمالية متاحة يومين فقط في الأسبوع لنحو 250 أسرة.',
      expect: 'NUMBER_INVENTED',
    },
  },
];

describe('AC 5 — a correct summary raises no warnings', () => {
  for (const f of FIXTURES) {
    it(f.name, () => {
      expect(verifySummary(f.source, f.good, f.facts)).toEqual([]);
    });
  }
});

describe('AC 5 — the failure each fixture exists to catch is caught', () => {
  for (const f of FIXTURES) {
    it(f.name, () => {
      const warnings = verifySummary(f.source, f.bad.summary, f.facts);
      expect(warnings.map((w) => w.code)).toContain(f.bad.expect);
    });
  }
});

describe('the three checks, in isolation', () => {
  const SOURCE = 'Water in Al-Jumum North reaches 40 households two days per week.';

  it('FACT_NOT_IN_SOURCE — the model vouched for something it invented', () => {
    const w = verifySummary(SOURCE, 'Water in Al-Jumum North is limited.', ['Al-Daer Central']);
    expect(w).toEqual([{ code: 'FACT_NOT_IN_SOURCE', detail: 'Al-Daer Central' }]);
  });

  it('does not also report a dropped fact for one it never had', () => {
    const w = verifySummary(SOURCE, 'Water is limited.', ['Al-Daer Central']);
    expect(w).toHaveLength(1);
  });

  it('FACT_DROPPED — kept in the source, lost from the summary', () => {
    const w = verifySummary(SOURCE, 'Water supply is limited to two days per week.', ['Al-Jumum North']);
    expect(w).toEqual([{ code: 'FACT_DROPPED', detail: 'Al-Jumum North' }]);
  });

  it('NUMBER_INVENTED — a count in the summary that is nowhere in the source', () => {
    const w = verifySummary(SOURCE, 'Water reaches 90 households in Al-Jumum North.', []);
    expect(w).toEqual([{ code: 'NUMBER_INVENTED', detail: '90' }]);
  });

  it('a number carried over correctly is not flagged', () => {
    expect(verifySummary(SOURCE, 'Water reaches 40 households.', [])).toEqual([]);
  });
});

describe('normalisation — the checks must not fire on cosmetic differences', () => {
  it('tolerates hyphen-vs-space in a place name', () => {
    const src = 'Households in Al Jumum North report a water shortage.';
    expect(verifySummary(src, 'Al-Jumum North reports a water shortage.', ['Al Jumum North'])).toEqual([]);
  });

  it('tolerates case and trailing punctuation', () => {
    const src = 'Residents of BANI YAS, and nearby areas, report spoilage.';
    expect(verifySummary(src, 'Residents of Bani Yas report spoilage.', ['bani yas'])).toEqual([]);
  });

  it('treats a thousands separator as the same number', () => {
    const src = 'The study covers 13,800 households.';
    expect(verifySummary(src, 'The study covers 13800 households.', [])).toEqual([]);
  });

  it('treats Arabic-Indic digits as the same number as ASCII', () => {
    const src = 'إمدادات المياه متاحة ٢ يوم في الأسبوع.';
    expect(verifySummary(src, 'Water is available 2 days per week.', [])).toEqual([]);
  });

  it('ignores a fact too short to match meaningfully', () => {
    // A two-character "fact" would match almost any text by accident, which
    // would make both fact checks worthless.
    expect(verifySummary('Anything at all.', 'Something else.', ['ab'])).toEqual([]);
  });
});

describe('warning encoding round-trips', () => {
  it('survives a detail containing a colon', () => {
    const warnings = [{ code: 'FACT_DROPPED' as const, detail: 'Ward 3: north sector' }];
    expect(decodeWarnings(encodeWarnings(warnings))).toEqual(warnings);
  });

  it('round-trips an empty list', () => {
    expect(decodeWarnings(encodeWarnings([]))).toEqual([]);
  });
});
