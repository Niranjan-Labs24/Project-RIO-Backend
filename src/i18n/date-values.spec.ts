import { describe, expect, it } from "vitest";
import { localiseDateText } from "./date-values";

describe("localiseDateText", () => {
  it("translates the month name that leaked into the Arabic RPT06", () => {
    // en-GB's four-letter short form. This exact string is what appeared on
    // page 1 of RPT06-…-ar.pdf, and is why the month table is built from Intl
    // rather than written by hand.
    expect(localiseDateText("01 Sept 2026", "ar")).toBe("01 سبتمبر 2026");
  });

  it("keeps the digits, the Gregorian calendar and the day/year unchanged", () => {
    const out = localiseDateText("15 July 2026", "ar");
    expect(out).toContain("15");
    expect(out).toContain("2026");
    // Western digits, not Arabic-Indic — pinned, and an open client question.
    expect(out).not.toMatch(/[٠-٩]/);
  });

  it("rewrites both halves of a stored assessment period", () => {
    // Written into report content at GENERATION time, so the source Date is
    // long gone by export and only this string survives.
    const out = localiseDateText("01 July 2026 - 15 July 2026", "ar");
    expect(out).toBe("01 يوليو 2026 - 15 يوليو 2026");
  });

  it("keeps a 24-hour stamp on a 24-hour clock", () => {
    const out = localiseDateText("22 Jul 2026, 16:30", "ar");
    expect(out).toContain("16:30");
    // Arabic's default is 12-hour with ص/م, which would make one instant read
    // differently in the two editions of the same report.
    expect(out).not.toMatch(/[صم]/);
  });

  it("leaves English alone", () => {
    expect(localiseDateText("01 Sept 2026", "en")).toBe("01 Sept 2026");
  });

  it("returns non-dates by identity", () => {
    // The function runs over every value in the document, including village
    // names and free text. Anything it does not recognise must survive exactly.
    for (const text of ["Al-Wajh", "Severity 4.2 of 5", "", "12 households", "Education"]) {
      expect(localiseDateText(text, "ar")).toBe(text);
    }
  });

  it("does not treat a number followed by a word as a date", () => {
    expect(localiseDateText("45 Marchmont Road", "ar")).toBe("45 Marchmont Road");
  });

  it("rejects an impossible day rather than inventing a date", () => {
    expect(localiseDateText("99 July 2026", "ar")).toBe("99 July 2026");
  });
});
