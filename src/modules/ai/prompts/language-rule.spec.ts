import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DETECTED_LANGUAGE_PROPERTY, LANGUAGE_RULE, languageDirective } from "./language-rule";
import { VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT } from "./village-report-summary.system";
import { INDIVIDUAL_SURVEY_SUMMARY_SYSTEM_PROMPT } from "./individual-survey-summary.system";
import { COMBINED_REPORT_SUMMARY_SYSTEM_PROMPT } from "./combined-report-summary.system";
import { EXECUTIVE_REPORT_SUMMARY_SYSTEM_PROMPT } from "./executive-report-summary.system";
import { REGION_REPORT_SUMMARY_SYSTEM_PROMPT } from "./region-report-summary.system";
import { SECTOR_REPORT_SUMMARY_SYSTEM_PROMPT } from "./sector-report-summary.system";
import { PRIORITY_DASHBOARD_SUMMARY_SYSTEM_PROMPT } from "./priority-dashboard-summary.system";
import { EVIDENCE_DOCUMENT_SUMMARY_TASK } from "./evidence-document-summary.task";
import { MESSAGES } from "../../../i18n/messages";

const REPORT_PROMPTS: Array<[string, string]> = [
  ["village", VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT],
  ["individual", INDIVIDUAL_SURVEY_SUMMARY_SYSTEM_PROMPT],
  ["combined", COMBINED_REPORT_SUMMARY_SYSTEM_PROMPT],
  ["executive", EXECUTIVE_REPORT_SUMMARY_SYSTEM_PROMPT],
  ["region", REGION_REPORT_SUMMARY_SYSTEM_PROMPT],
  ["sector", SECTOR_REPORT_SUMMARY_SYSTEM_PROMPT],
  ["priority-dashboard", PRIORITY_DASHBOARD_SUMMARY_SYSTEM_PROMPT],
  ["evidence-document", EVIDENCE_DOCUMENT_SUMMARY_TASK.systemPrompt],
];

describe("system prompts", () => {
  it.each(REPORT_PROMPTS)("%s carries the language rule", (_name, prompt) => {
    expect(prompt).toContain("LANGUAGE:");
    expect(prompt).toContain("outputLanguage");
  });

  it.each(REPORT_PROMPTS)("%s hardcodes no English sentence to be copied", (_name, prompt) => {
    // The subtlest leak in the whole effort: a prompt that correctly says
    // "write Arabic" and then hands the model an English sentence to reproduce
    // verbatim. Those phrases are now supplied per-locale in the user turn.
    expect(prompt).not.toContain("Cycle 1 assessment");
    expect(prompt).not.toContain("Data not available in this assessment");
    expect(prompt).not.toContain("Data not available in this document");
  });

  it("keeps the language rule identical across every prompt", () => {
    // The rule must be byte-identical everywhere and per call, because
    // promptHashOf hashes only the system prompt. A rule that varied by locale
    // would give one task a different hash per request and destroy the audit
    // trail that hash exists to provide.
    for (const [name, prompt] of REPORT_PROMPTS) {
      expect(prompt.endsWith(LANGUAGE_RULE), name).toBe(true);
    }
  });
});

describe("languageDirective", () => {
  it("names the requested language", () => {
    expect(languageDirective("ar")).toContain("outputLanguage: ar");
    expect(languageDirective("en")).toContain("outputLanguage: en");
  });

  it("supplies the fixed sentences in that language", () => {
    const ar = languageDirective("ar");
    expect(ar).toContain(MESSAGES.ar["narrative.cycle1TrendPending"]);
    expect(ar).toContain(MESSAGES.ar["narrative.dataNotAvailable"]);
    // ...and none of the English wording those replaced.
    expect(ar).not.toContain("Trend Pending");
    expect(ar).not.toContain("Data not available in this assessment");

    const en = languageDirective("en");
    expect(en).toContain(MESSAGES.en["narrative.cycle1TrendPending"]);
  });

  it("defaults to English", () => {
    expect(languageDirective()).toContain("outputLanguage: en");
  });

  it("does not change the system prompt's hash between locales", () => {
    // The property that protects the audit trail: the language travels in the
    // user turn, so the hashed system prompt is the same for both editions.
    const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(hash(VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT)).toBe(
      hash(VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT),
    );
    expect(languageDirective("ar")).not.toBe(languageDirective("en"));
  });
});

describe("DETECTED_LANGUAGE_PROPERTY", () => {
  it("is a closed two-value enum", () => {
    expect(DETECTED_LANGUAGE_PROPERTY.detectedLanguage).toEqual({
      type: "STRING",
      enum: ["ar", "en"],
    });
  });
});
