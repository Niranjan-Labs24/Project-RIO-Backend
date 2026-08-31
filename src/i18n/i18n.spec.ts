import { describe, expect, it } from 'vitest';
import { APP_LOCALES, isRtl, localeFromAcceptLanguage, toAppLocale } from './locale';
import { MESSAGES, type MessageKey } from './messages';
import { translate, translator } from './translate';
import { latinRuns } from '../modules/ai/language/detect-script';

describe('locale resolution', () => {
  it('falls back rather than throwing on an unrecognised locale', () => {
    // An export URL with a misspelled ?locale= should still produce a file.
    // Refusing the download to enforce a query-string preference is a worse
    // outcome than quietly serving English.
    expect(toAppLocale('fr')).toBe('en');
    expect(toAppLocale(undefined)).toBe('en');
    expect(toAppLocale('ar')).toBe('ar');
    expect(toAppLocale(null, 'ar')).toBe('ar');
  });

  it('reads the first supported tag from Accept-Language', () => {
    expect(localeFromAcceptLanguage('ar-SA,ar;q=0.9,en;q=0.8')).toBe('ar');
    expect(localeFromAcceptLanguage('en-GB,en;q=0.9')).toBe('en');
    // Unsupported languages are skipped, not treated as a match.
    expect(localeFromAcceptLanguage('fr-FR,de;q=0.8,ar;q=0.5')).toBe('ar');
    expect(localeFromAcceptLanguage('fr-FR,de;q=0.8')).toBe('en');
    expect(localeFromAcceptLanguage(undefined)).toBe('en');
    expect(localeFromAcceptLanguage('')).toBe('en');
  });

  it('marks Arabic as right-to-left and English as not', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en')).toBe(false);
  });
});

describe('message catalogue', () => {
  it('has an entry in every locale for every key', () => {
    // The Record<MessageKey, string> type already enforces this at compile
    // time. Asserting it again at runtime is not redundant: it catches a key
    // present but EMPTY, which the type cannot see and which renders as a blank
    // label in a client-facing report.
    const keys = Object.keys(MESSAGES.en) as MessageKey[];
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of APP_LOCALES) {
      for (const key of keys) {
        expect(MESSAGES[locale][key], `${locale}/${key}`).toBeTruthy();
      }
    }
  });

  it('contains no untranslated English in the Arabic catalogue', () => {
    // The direct test of the client's requirement, applied to the one surface
    // fully under our control. Reference data (domain, geography) is excluded
    // by design — it lives in nameAr columns, not here.
    const offenders: string[] = [];
    for (const [key, value] of Object.entries(MESSAGES.ar)) {
      // Parameter names are identifiers, not prose — `{required}` is Latin text
      // that never reaches a reader, and counting it would make this assertion
      // impossible to satisfy for any parameterised message.
      const runs = latinRuns(value.replace(/\{\w+\}/g, ''));
      if (runs.length > 0) offenders.push(`${key}: ${runs.join(' ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every parameter placeholder intact across locales', () => {
    // A dropped {n} in a translation silently deletes a figure from a report.
    // A renamed one leaves a literal "{count}" on the page. Both are worse than
    // an English sentence, so both are caught here.
    const keys = Object.keys(MESSAGES.en) as MessageKey[];
    const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of keys) {
      for (const locale of APP_LOCALES) {
        expect(placeholders(MESSAGES[locale][key]), key).toEqual(placeholders(MESSAGES.en[key]));
      }
    }
  });
});

describe('translate', () => {
  it('substitutes named parameters', () => {
    expect(
      translate('en', 'confidence.smallSample', { n: 4, required: 30 }),
    ).toContain('4 valid response(s), below the 30');
  });

  it('substitutes the same parameters into Arabic', () => {
    const out = translate('ar', 'confidence.smallSample', { n: 4, required: 30 });
    expect(out).toContain('4');
    expect(out).toContain('30');
    expect(latinRuns(out)).toEqual([]);
  });

  it('leaves an unsupplied placeholder visible rather than printing undefined', () => {
    // "{required}" on a page is an obvious bug someone fixes. "undefined" reads
    // like a value, and a reader may take it for one.
    expect(translate('en', 'confidence.smallSample', { n: 4 })).toContain('{required}');
  });

  it('curries', () => {
    const t = translator('ar');
    expect(t('label.village')).toBe(MESSAGES.ar['label.village']);
  });
});
