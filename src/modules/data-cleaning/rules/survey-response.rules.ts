// RIO-FR-002 — the rules that apply to a citizen's survey response.
//
// ─── A privacy constraint the other two sources do not have ─────────────────
// A response carries respondent PII: contact (email) and mobile. A cleaning
// flag normally stores the value it is complaining about and the value it
// proposes, so a reviewer can compare them — but doing that here would copy
// every respondent's email and phone number into a second, reviewer-facing
// table, widening who can read them and where they live.
//
// RIO-NFR-002 already forbids putting a respondent's contact details in the
// audit log for exactly this reason. cleaning_flags is a different table, but
// the reasoning transfers, and "the audit log rule technically does not cover
// this table" is not a privacy argument.
//
// So for a field named in settings.piiFields, the flag records the rule, a
// MASKED original, and NO proposal. The reviewer sees that a number is
// malformed and what shape it will take; the accept action recomputes the
// normalized value server-side from the live row. That works precisely because
// the normalizers are pure — the same input always yields the same output, so
// nothing needs to be stored to reproduce it.

import type { CleaningContext } from "../cleaning-context.service";
import type { PendingFlag } from "../data-cleaning.types";
import { matchPlace, normalizePhone } from "../normalizers";

export interface SurveyResponseCleaningInput {
  id: string;
  contact: string | null;
  mobile: string | null;
  village: string[];
}

/**
 * Show enough to recognise the value, not enough to reuse it.
 *   "+966501234567" -> "+9665•••••67"
 *   "sarah@example.com" -> "sa•••@example.com"
 */
export function maskPii(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const at = trimmed.indexOf("@");
  if (at > 0) {
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at);
    const head = local.slice(0, Math.min(2, local.length));
    return `${head}${"•".repeat(Math.max(1, local.length - head.length))}${domain}`;
  }

  if (trimmed.length <= 4) return "•".repeat(trimmed.length);
  const head = trimmed.slice(0, Math.min(5, trimmed.length - 2));
  const tail = trimmed.slice(-2);
  return `${head}${"•".repeat(Math.max(1, trimmed.length - head.length - tail.length))}${tail}`;
}

export function evaluateSurveyResponse(
  response: SurveyResponseCleaningInput,
  context: CleaningContext,
): PendingFlag[] {
  const flags: PendingFlag[] = [];
  const { settings } = context;
  const required = new Set(settings.requiredSurveyResponseFields);
  const pii = new Set(settings.piiFields);

  const base = {
    entityType: "survey_response" as const,
    entityId: response.id,
    rowNumber: null,
  };

  if (required.has("contact") && !response.contact?.trim()) {
    flags.push({
      ...base,
      field: "contact",
      ruleCode: "MISSING_REQUIRED",
      severity: "missing",
      originalValue: null,
      proposedValue: null,
      confidence: null,
      detail: { field: "contact" },
    });
  }

  // ── Mobile number to one international format (Q12) ─────────────────────
  if (response.mobile?.trim()) {
    const result = normalizePhone(response.mobile, {
      field: "mobile",
      // Never required: a response verified by email has no mobile, and both
      // channels are legitimate under the OTP flow.
      required: false,
      dontKnowTreatment: settings.dontKnowTreatment,
      defaultRegion: settings.phoneDefaultRegion,
    });
    if (result.flag) {
      const redact = pii.has("mobile");
      flags.push({
        ...base,
        field: "mobile",
        ...result.flag,
        originalValue: redact
          ? maskPii(result.flag.originalValue ?? "")
          : result.flag.originalValue,
        // The full normalized number is as identifying as the original, so it
        // is not stored either. Accepting the flag recomputes it.
        proposedValue: redact ? null : result.flag.proposedValue,
        detail: {
          ...(result.flag.detail ?? {}),
          redacted: redact,
          ...(redact && result.flag.proposedValue
            ? { proposedShape: maskPii(result.flag.proposedValue) }
            : {}),
        },
      });
    }
  }

  // ── Village snapshot against the geographic reference (Q12) ─────────────
  //
  // A response's `village` is copied from its Need at submission time, so an
  // unmatched village here mirrors an unmatched village there. Flagged anyway,
  // and per-source: the Data Quality report is meant to show what is wrong
  // with each SOURCE's data, and "the responses inherited a bad village" is a
  // true statement about the response source.
  if (context.places.length > 0) {
    response.village.forEach((village, index) => {
      if (!village.trim()) return;
      const result = matchPlace(village, {
        field: `village[${index}]`,
        required: false,
        dontKnowTreatment: settings.dontKnowTreatment,
        reference: context.places,
        acceptThreshold: settings.villageMatchAcceptThreshold,
        proposeThreshold: settings.villageMatchProposeThreshold,
        maxCandidates: settings.villageMatchMaxCandidates,
      });
      if (result.flag) {
        flags.push({ ...base, field: `village[${index}]`, ...result.flag });
      }
    });
  }

  return flags;
}
