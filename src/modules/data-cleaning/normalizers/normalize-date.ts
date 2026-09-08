// RIO-FR-002 / Q12 — "dates to a single format".
//
// The standard form is ISO 8601 calendar dates, YYYY-MM-DD. No time, no zone:
// every date this rule touches is a calendar day someone wrote on a form, and
// attaching a timezone to it invents precision that was never collected.

import { classifyPresence, type DontKnowTreatment } from "./dont-know";
import {
  clean,
  missing,
  proposed,
  unresolved,
  type NormalizationResult,
} from "./types";

export interface DateNormalizerOptions {
  field: string;
  required: boolean;
  dontKnowTreatment: DontKnowTreatment;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
// Separator-agnostic three-part date: 5/3/2026, 05-03-2026, 5.3.2026.
const THREE_PART = /^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/;
// An ISO datetime, which several exports produce for a plain date field.
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ][\d:.]+(?:Z|[+\-]\d{2}:?\d{2})?$/;

const ARABIC_INDIC_ZERO = 0x0660;

/** Arabic-Indic digits to ASCII, and Arabic separators to ASCII ones. */
function normalizeDigits(input: string): string {
  let out = "";
  for (const ch of input.trim()) {
    const code = ch.codePointAt(0)!;
    if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
      out += String(code - ARABIC_INDIC_ZERO);
    } else {
      out += ch;
    }
  }
  return out;
}

/** Real-calendar check — rejects 2026-02-30, accepts 2024-02-29. */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Normalize one raw date value to YYYY-MM-DD.
 *
 * Day-first is the assumed reading for an ambiguous three-part date: the
 * platform is Arabic-first and its users write dates day-first. But when the
 * month-first reading is ALSO a real date and gives a different day — 03/04
 * could be 3 April or 4 March — the result is flagged DATE_AMBIGUOUS at
 * confidence 0.5 rather than silently picking one. The reviewer sees both
 * readings in `detail` and confirms. 25/12/2026 has only one valid reading and
 * so is not ambiguous.
 *
 * Two-digit years are refused outright rather than assigned a century. "05" is
 * 1905 or 2005 depending on a convention nobody has agreed, and a wrong
 * century in a study date is worse than a flag asking someone to retype it.
 */
export function normalizeDate(
  raw: string | null | undefined,
  options: DateNormalizerOptions,
): NormalizationResult<string> {
  const presence = classifyPresence(raw, options.dontKnowTreatment);
  if (presence === "excluded") return clean<string>(null);
  if (presence === "absent") {
    return options.required ? missing<string>(options.field) : clean<string>(null);
  }

  const original = raw!.trim();
  const value = normalizeDigits(original);

  const isoMatch = ISO.exec(value);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (!isRealDate(year, month, day)) {
      return unresolved<string>({
        ruleCode: "DATE_UNPARSEABLE",
        severity: "non_standard",
        originalValue: original,
        confidence: null,
        detail: { field: options.field, reason: "not_a_real_calendar_date" },
      });
    }
    // Already standard — but only if the digits were ASCII to begin with.
    if (value === original) return clean(value);
    return proposed(value, {
      ruleCode: "DATE_FORMAT",
      severity: "non_standard",
      originalValue: original,
      proposedValue: value,
      confidence: null,
      detail: { field: options.field, reason: "arabic_indic_digits" },
    });
  }

  const datetimeMatch = ISO_DATETIME.exec(value);
  if (datetimeMatch) {
    const [, y, m, d] = datetimeMatch;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (isRealDate(year, month, day)) {
      const standard = iso(year, month, day);
      return proposed(standard, {
        ruleCode: "DATE_FORMAT",
        severity: "non_standard",
        originalValue: original,
        proposedValue: standard,
        confidence: null,
        detail: { field: options.field, reason: "time_component_dropped" },
      });
    }
  }

  const parts = THREE_PART.exec(value);
  if (parts) {
    const [, first, second, third] = parts;
    const a = Number(first);
    const b = Number(second);
    const c = Number(third);

    // YYYY/MM/DD — unambiguous, the year is where a day cannot be.
    if (first!.length === 4) {
      if (isRealDate(a, b, c)) {
        const standard = iso(a, b, c);
        return standard === original
          ? clean(standard)
          : proposed(standard, {
              ruleCode: "DATE_FORMAT",
              severity: "non_standard",
              originalValue: original,
              proposedValue: standard,
              confidence: null,
              detail: { field: options.field, reading: "year_first" },
            });
      }
      return unresolved<string>({
        ruleCode: "DATE_UNPARSEABLE",
        severity: "non_standard",
        originalValue: original,
        confidence: null,
        detail: { field: options.field, reason: "not_a_real_calendar_date" },
      });
    }

    if (third!.length !== 4) {
      return unresolved<string>({
        ruleCode: "DATE_UNPARSEABLE",
        severity: "non_standard",
        originalValue: original,
        confidence: null,
        detail: {
          field: options.field,
          reason: "two_digit_year",
          explanation: "A century cannot be assumed; the value has to be retyped in full.",
        },
      });
    }

    const dayFirst = isRealDate(c, b, a);
    const monthFirst = isRealDate(c, a, b);

    if (dayFirst && monthFirst && a !== b) {
      const standard = iso(c, b, a);
      return proposed(standard, {
        ruleCode: "DATE_AMBIGUOUS",
        severity: "non_standard",
        originalValue: original,
        proposedValue: standard,
        confidence: 0.5,
        detail: {
          field: options.field,
          dayFirst: iso(c, b, a),
          monthFirst: iso(c, a, b),
        },
      });
    }
    if (dayFirst) {
      const standard = iso(c, b, a);
      return proposed(standard, {
        ruleCode: "DATE_FORMAT",
        severity: "non_standard",
        originalValue: original,
        proposedValue: standard,
        confidence: null,
        detail: { field: options.field, reading: "day_first" },
      });
    }
    if (monthFirst) {
      const standard = iso(c, a, b);
      return proposed(standard, {
        ruleCode: "DATE_FORMAT",
        severity: "non_standard",
        originalValue: original,
        proposedValue: standard,
        confidence: null,
        detail: { field: options.field, reading: "month_first" },
      });
    }
  }

  return unresolved<string>({
    ruleCode: "DATE_UNPARSEABLE",
    severity: "non_standard",
    originalValue: original,
    confidence: null,
    detail: { field: options.field, reason: "unrecognised_shape" },
  });
}
