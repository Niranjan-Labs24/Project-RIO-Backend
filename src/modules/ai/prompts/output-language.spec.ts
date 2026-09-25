import { describe, expect, it } from 'vitest';
import { FIXED_SENTENCES_AR, withOutputLanguage } from './output-language';
import { VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT } from './village-report-summary.system';

describe('withOutputLanguage', () => {
  it('leaves the English prompt byte-for-byte unchanged', () => {
    // Stored English summaries carry the hash of this exact text; any change
    // would make every one of them look stale.
    expect(withOutputLanguage(VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT, 'en')).toBe(
      VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT,
    );
  });

  it('appends the Arabic directive, keeping the reviewed prompt intact above it', () => {
    const ar = withOutputLanguage(VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT, 'ar');
    expect(ar.startsWith(VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT)).toBe(true);
    expect(ar).toContain('OUTPUT LANGUAGE — ARABIC');
    expect(ar).toContain('Never translate a key');
  });

  it('gives the Arabic for every fixed English sentence a prompt names', () => {
    const ar = withOutputLanguage(VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT, 'ar');
    for (const [en, arabic] of FIXED_SENTENCES_AR) {
      expect(ar).toContain(`"${en}" → "${arabic}"`);
      expect(arabic).toMatch(/[؀-ۿ]/);
    }
  });

  it('covers the fixed sentences the village prompt actually uses', () => {
    const named = FIXED_SENTENCES_AR.map(([en]) => en);
    for (const sentence of VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT.match(/'[^']+\.'/g) ?? []) {
      expect(named).toContain(sentence.slice(1, -1));
    }
  });
});
