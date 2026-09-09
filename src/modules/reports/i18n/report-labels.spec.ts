import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasLabel,
  keyForEnglish,
  label,
  localizeKnownLabel,
  type ReportLabelKey,
} from './report-labels';
import { REPORT_LABELS_AR, REPORT_LABELS_EN } from './report-labels.generated';

const REPORT_DOC = resolve(__dirname, '..', 'report-doc.ts');

/** The literal `heading: "..."` strings report-doc.ts still hardcodes. */
function hardcodedHeadings(): string[] {
  const src = readFileSync(REPORT_DOC, 'utf8');
  return [...new Set([...src.matchAll(/heading: "([^"]*)"/g)].map((m) => m[1]!))].filter((h) =>
    h.trim(),
  );
}

describe('report label catalogue', () => {
  it('has an Arabic entry for every English one', () => {
    const missing = Object.keys(REPORT_LABELS_EN).filter(
      (k) => REPORT_LABELS_AR[k as ReportLabelKey] === undefined,
    );
    expect(missing, 'keys with no Arabic — the export would print English').toEqual([]);
  });

  it('carries no untranslated English in the Arabic side', () => {
    // A label whose "Arabic" is still the English string is the failure this
    // whole effort exists to remove, and it is invisible from the export.
    // Latin runs are allowed only where the English is itself not words —
    // "0-100", "#", "±{value} points".
    const suspicious = (Object.keys(REPORT_LABELS_EN) as ReportLabelKey[]).filter((k) => {
      const ar = REPORT_LABELS_AR[k]!;
      const en = REPORT_LABELS_EN[k];
      return /[A-Za-z]{4,}/.test(ar) && ar.trim() === en.trim();
    });
    expect(suspicious, 'Arabic identical to English').toEqual([]);
  });

  it('is in sync with the frontend catalogue it was generated from', () => {
    // The vendored copy rots silently the first time someone edits ar.json.
    // Skipped rather than failed when the sibling checkout is absent — CI has
    // both, a backend-only machine legitimately does not.
    const frontendAr = resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      'Project-RIO-Frontend',
      'messages',
      'ar.json',
    );
    if (!existsSync(frontendAr)) return;

    const content = JSON.parse(readFileSync(frontendAr, 'utf8')).app.reports.content as Record<
      string,
      unknown
    >;
    const flat: Record<string, string> = {};
    const walk = (node: unknown, prefix: string): void => {
      if (typeof node === 'string') {
        flat[prefix] = node;
        return;
      }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, prefix ? `${prefix}.${k}` : k);
      }
    };
    walk(content, '');

    const drifted = (Object.keys(REPORT_LABELS_AR) as ReportLabelKey[]).filter(
      (k) => flat[k] !== undefined && flat[k] !== REPORT_LABELS_AR[k],
    );
    expect(drifted, 'run `pnpm sync:report-labels` — vendored labels are stale').toEqual([]);
  });
});

describe('label()', () => {
  it('returns the locale wording', () => {
    expect(label('severity', 'en')).toBe('Severity');
    expect(label('severity', 'ar')).toBe('الشدة');
  });

  it('substitutes simple placeholders', () => {
    expect(label('pn.rankingBasis', 'en', { basis: 'severity score' })).toContain(
      'Ranked by severity score.',
    );
    expect(label('pn.rankingBasis', 'ar', { basis: 'درجة الشدة' })).toContain('درجة الشدة');
  });

  it('throws rather than printing an unfilled placeholder', () => {
    // A released PDF reading "Ranked by {basis}." is worse than a loud failure
    // during generation.
    expect(() => label('pn.rankingBasis', 'en')).toThrow(/needs a "basis" parameter/);
  });

  it('refuses full ICU instead of emitting wrong grammar', () => {
    // findingCount is "{count, plural, one {# finding} other {# findings}}".
    // Arabic has six plural categories; a partial implementation would quietly
    // produce wrong grammar in a document that gets approved and archived.
    expect(() => label('findingCount', 'ar', { count: 3 })).toThrow(/full ICU syntax/);
  });
});

describe('report-doc.ts heading coverage', () => {
  const headings = hardcodedHeadings();
  const resolved = headings.filter((h) => keyForEnglish(h) !== null);

  it('resolves every hardcoded heading to a catalogue key', () => {
    const unresolved = headings.filter((h) => keyForEnglish(h) === null);
    expect(
      unresolved,
      'headings with no catalogue key — these would stay English in an Arabic export',
    ).toEqual([]);
  });

  it('translates every one of them to Arabic', () => {
    for (const h of resolved) {
      const ar = localizeKnownLabel(h, 'ar');
      expect(ar, `"${h}" did not translate`).not.toBe(h);
      expect(/[؀-ۿ]/.test(ar), `"${h}" -> "${ar}" is not Arabic`).toBe(true);
    }
  });

  it('leaves English untouched for the en locale', () => {
    for (const h of headings) expect(localizeKnownLabel(h, 'en')).toBe(h);
  });
});

describe('hasLabel', () => {
  it('narrows a known key', () => {
    expect(hasLabel('severity')).toBe(true);
    expect(hasLabel('definitely-not-a-key')).toBe(false);
  });
});

describe("numeric phrases", () => {
  // The report builders glue a computed figure to a fixed unit phrase
  // ("38 valid", "12% don't-know"). One rule handles all of them: split the
  // number off, translate the remainder, put the number back.
  it("translates the unit and keeps the figure in Latin digits", () => {
    expect(localizeKnownLabel("38 valid", "ar")).toBe("38 " + label("dq.valid", "ar"));
    expect(localizeKnownLabel("12% don't-know", "ar")).toBe("12% " + label("cov.dontKnow", "ar"));
    expect(localizeKnownLabel("1 governorate(s)", "ar")).toBe(
      "1 " + label("cov.governorates", "ar"),
    );
  });

  it("handles a compound of two figures", () => {
    const out = localizeKnownLabel("24 asked · 0 not measurable", "ar");
    expect(out).toBe(`24 ${label("cov.asked", "ar")} · 0 ${label("es.notMeasurable", "ar")}`);
  });

  it("never rewrites the digits themselves", () => {
    // Latin digits regardless of locale is the project convention, and these
    // are figures in a document that gets approved and archived.
    for (const input of ["38 valid", "90% of submitted", "24 asked · 0 not measurable"]) {
      const digits = (s: string) => s.match(/[\d.,%]+/g) ?? [];
      expect(digits(localizeKnownLabel(input, "ar"))).toEqual(digits(input));
    }
    expect(/[٠-٩]/.test(localizeKnownLabel("38 valid", "ar"))).toBe(false);
  });

  it("leaves a phrase it cannot resolve completely alone", () => {
    // Two figures with no single unit phrase between them. A half-translated
    // compound reads worse than an untranslated one, and the audit can see it.
    for (const input of ["25 bank / 3 custom", "sample 38 / 10", "Prioritise water access."]) {
      expect(localizeKnownLabel(input, "ar")).toBe(input);
    }
  });

  it("does nothing in English", () => {
    expect(localizeKnownLabel("38 valid", "en")).toBe("38 valid");
  });
});
