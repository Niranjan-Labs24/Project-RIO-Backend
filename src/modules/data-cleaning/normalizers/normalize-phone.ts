// RIO-FR-002 / Q12 — "mobile numbers to one international format".
//
// The standard form is E.164: a leading + followed by country code and
// subscriber number, no spaces, dashes, parentheses or leading zeros.
//
// Why this matters beyond tidiness: SurveyResponse enforces one response per
// need per mobile number (@@unique([needId, mobile])). "0501234567" and
// "+966 50 123 4567" are the same person and the same phone, but they are two
// different strings, so an unstandardized number is a way for one respondent
// to be counted twice.
//
// Deliberately hand-rolled rather than pulling in libphonenumber: the only
// region with real rules here is Saudi Arabia, the ruleset below is the whole
// of it, and a 500KB metadata dependency to reformat one country's mobile
// numbers is not a trade worth making.

import { classifyPresence, type DontKnowTreatment } from "./dont-know";
import {
  clean,
  missing,
  proposed,
  unresolved,
  type NormalizationResult,
} from "./types";

export interface PhoneNormalizerOptions {
  field: string;
  required: boolean;
  dontKnowTreatment: DontKnowTreatment;
  /** ISO country code the local-format numbers belong to. "SA" today. */
  defaultRegion: string;
}

const ARABIC_INDIC_ZERO = 0x0660;
const EASTERN_ARABIC_ZERO = 0x06f0;

const SAUDI_COUNTRY_CODE = "966";
// Saudi mobile subscriber numbers are 9 digits beginning 5.
const SAUDI_MOBILE_SUBSCRIBER = /^5\d{8}$/;

/** Keep digits and a single leading +, mapping Arabic-Indic digits to ASCII. */
function toDigits(input: string): { plus: boolean; digits: string } {
  let digits = "";
  let plus = false;
  let seenDigit = false;
  for (const ch of input.trim()) {
    const code = ch.codePointAt(0)!;
    if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
      digits += String(code - ARABIC_INDIC_ZERO);
      seenDigit = true;
    } else if (code >= EASTERN_ARABIC_ZERO && code <= EASTERN_ARABIC_ZERO + 9) {
      digits += String(code - EASTERN_ARABIC_ZERO);
      seenDigit = true;
    } else if (ch >= "0" && ch <= "9") {
      digits += ch;
      seenDigit = true;
    } else if (ch === "+" && !seenDigit) {
      plus = true;
    }
    // Everything else — spaces, dashes, parentheses, dots — is formatting.
  }
  return { plus, digits };
}

/**
 * Normalize one raw mobile number to E.164.
 *
 * Accepted Saudi shapes, all yielding +9665XXXXXXXX:
 *   05XXXXXXXX      national trunk form, the one people actually write
 *   5XXXXXXXX       subscriber only
 *   9665XXXXXXXX    country code, no plus
 *   009665XXXXXXXX  international access prefix
 *   +966 50 123 4567 and every punctuation variant of the above
 *
 * A number that already carries a + and some other country code is passed
 * through with its formatting stripped: we are not in a position to validate
 * another country's numbering plan, and rejecting a foreign number a
 * researcher legitimately recorded would be worse than accepting it as given.
 */
export function normalizePhone(
  raw: string | null | undefined,
  options: PhoneNormalizerOptions,
): NormalizationResult<string> {
  const presence = classifyPresence(raw, options.dontKnowTreatment);
  if (presence === "excluded") return clean<string>(null);
  if (presence === "absent") {
    return options.required ? missing<string>(options.field) : clean<string>(null);
  }

  const original = raw!.trim();
  const { plus, digits } = toDigits(original);

  if (digits.length === 0) {
    return unresolved<string>({
      ruleCode: "PHONE_UNPARSEABLE",
      severity: "non_standard",
      originalValue: original,
      confidence: null,
      detail: { field: options.field, reason: "no_digits" },
    });
  }

  const settle = (e164: string): NormalizationResult<string> =>
    e164 === original
      ? clean(e164)
      : proposed(e164, {
          ruleCode: "PHONE_FORMAT",
          severity: "non_standard",
          originalValue: original,
          proposedValue: e164,
          confidence: null,
          detail: { field: options.field, region: options.defaultRegion },
        });

  if (options.defaultRegion === "SA") {
    // Strip the international access prefix and the country code, in that
    // order, to arrive at the subscriber number.
    let subscriber = digits;
    if (subscriber.startsWith("00" + SAUDI_COUNTRY_CODE)) {
      subscriber = subscriber.slice(2 + SAUDI_COUNTRY_CODE.length);
    } else if (subscriber.startsWith(SAUDI_COUNTRY_CODE)) {
      subscriber = subscriber.slice(SAUDI_COUNTRY_CODE.length);
    } else if (!plus && subscriber.startsWith("0")) {
      subscriber = subscriber.slice(1);
    }

    if (SAUDI_MOBILE_SUBSCRIBER.test(subscriber)) {
      return settle(`+${SAUDI_COUNTRY_CODE}${subscriber}`);
    }
  }

  // A foreign number, given internationally. E.164 allows up to 15 digits and
  // no country code is shorter than one, so anything outside 8..15 is not a
  // phone number in any plan.
  if (plus && digits.length >= 8 && digits.length <= 15) {
    return settle(`+${digits}`);
  }

  return unresolved<string>({
    ruleCode: "PHONE_UNPARSEABLE",
    severity: "non_standard",
    originalValue: original,
    confidence: null,
    detail: {
      field: options.field,
      region: options.defaultRegion,
      digitCount: digits.length,
      reason:
        options.defaultRegion === "SA"
          ? "not_a_saudi_mobile_and_no_country_code"
          : "unrecognised_numbering_plan",
    },
  });
}
