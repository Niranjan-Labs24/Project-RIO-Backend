// RIO-FR-002 / Q12 — "domain and sub-domain values restricted to the approved
// methodology list".
//
// The nine domains and their sub-domains are the methodology's own closed
// vocabulary. A need filed under "Health Care" instead of "Health", or under a
// sub-domain that belongs to a different domain, silently drops out of every
// KPI rollup and every dashboard filter that groups by domain — the value is
// not wrong-looking, it is just not one of the nine.
//
// The vocabulary is passed in rather than imported: it lives in the Domain /
// SubDomain tables and is version-scoped to the methodology, so the adapter
// reads it and this function stays pure.

import { foldText, trigramSimilarity } from "./fold-text";
import { classifyPresence, type DontKnowTreatment } from "./dont-know";
import {
  clean,
  missing,
  proposed,
  unresolved,
  type NormalizationResult,
} from "./types";

export interface MethodologyVocabulary {
  /** Canonical domain name, exactly as it must be stored. */
  domain: string;
  /** Canonical sub-domain names under that domain. */
  subDomains: string[];
}

export interface ClassificationNormalizerOptions {
  field: string;
  required: boolean;
  dontKnowTreatment: DontKnowTreatment;
  vocabulary: MethodologyVocabulary[];
  /**
   * Below this, a near-match is not offered at all. Conservative by default,
   * per Q23's "start conservative, tune once real field data exists" — an
   * unrecognised value the reviewer has to classify by hand is a smaller
   * problem than a plausible-looking wrong suggestion they accept.
   */
  nearMatchThreshold: number;
}

interface Candidate {
  value: string;
  score: number;
}

function bestCandidates(raw: string, options: string[], limit = 3): Candidate[] {
  const folded = foldText(raw);
  return options
    .map((value) => ({ value, score: trigramSimilarity(folded, foldText(value)) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Resolve a raw domain name against the approved list.
 *
 * Three outcomes, deliberately distinguished:
 *   * exact match           — nothing to do
 *   * folded match          — the value IS one of the nine, written with
 *                             different spacing, case or Arabic orthography.
 *                             A deterministic reformat, not a guess.
 *   * near / no match       — the value is not in the vocabulary. Flagged
 *                             out_of_vocabulary, with a shortlist when one
 *                             clears the threshold and nothing when it does
 *                             not.
 */
export function normalizeDomain(
  raw: string | null | undefined,
  options: ClassificationNormalizerOptions,
): NormalizationResult<string> {
  const presence = classifyPresence(raw, options.dontKnowTreatment);
  if (presence === "excluded") return clean<string>(null);
  if (presence === "absent") {
    return options.required ? missing<string>(options.field) : clean<string>(null);
  }

  const original = raw!.trim();
  const canonicalDomains = options.vocabulary.map((v) => v.domain);

  const exact = canonicalDomains.find((d) => d === original);
  if (exact) return clean(exact);

  const foldedInput = foldText(original);
  const folded = canonicalDomains.find((d) => foldText(d) === foldedInput);
  if (folded) {
    return proposed(folded, {
      ruleCode: "DOMAIN_NOT_IN_METHODOLOGY",
      severity: "non_standard",
      originalValue: original,
      proposedValue: folded,
      confidence: null,
      detail: { field: options.field, reason: "spelling_variant_of_approved_value" },
    });
  }

  const candidates = bestCandidates(original, canonicalDomains);
  const top = candidates[0];
  if (top && top.score >= options.nearMatchThreshold) {
    return proposed(top.value, {
      ruleCode: "DOMAIN_NOT_IN_METHODOLOGY",
      severity: "out_of_vocabulary",
      originalValue: original,
      proposedValue: top.value,
      confidence: Number(top.score.toFixed(4)),
      detail: { field: options.field, candidates },
    });
  }

  return unresolved<string>({
    ruleCode: "DOMAIN_NOT_IN_METHODOLOGY",
    severity: "out_of_vocabulary",
    originalValue: original,
    confidence: null,
    detail: { field: options.field, candidates },
  });
}

export interface SubDomainNormalizerOptions extends ClassificationNormalizerOptions {
  /**
   * The domain the need is filed under, already resolved. Null when the domain
   * itself could not be resolved — the sub-domain is then checked against the
   * whole vocabulary, since there is no parent to check it under.
   */
  resolvedDomain: string | null;
}

/**
 * Resolve a raw sub-domain against the approved list.
 *
 * Carries one check the domain resolver does not: a sub-domain that IS
 * approved but belongs to a different domain. That combination scores and
 * reports cleanly at every step and is wrong in a way nothing downstream would
 * catch, so it gets its own rule code rather than being folded into
 * "not in methodology".
 */
export function normalizeSubDomain(
  raw: string | null | undefined,
  options: SubDomainNormalizerOptions,
): NormalizationResult<string> {
  const presence = classifyPresence(raw, options.dontKnowTreatment);
  if (presence === "excluded") return clean<string>(null);
  if (presence === "absent") {
    return options.required ? missing<string>(options.field) : clean<string>(null);
  }

  const original = raw!.trim();
  const parent = options.resolvedDomain
    ? options.vocabulary.find((v) => v.domain === options.resolvedDomain)
    : undefined;
  const inScope = parent ? parent.subDomains : options.vocabulary.flatMap((v) => v.subDomains);

  const exact = inScope.find((s) => s === original);
  if (exact) return clean(exact);

  const foldedInput = foldText(original);
  const folded = inScope.find((s) => foldText(s) === foldedInput);
  if (folded) {
    return proposed(folded, {
      ruleCode: "SUBDOMAIN_NOT_IN_METHODOLOGY",
      severity: "non_standard",
      originalValue: original,
      proposedValue: folded,
      confidence: null,
      detail: { field: options.field, reason: "spelling_variant_of_approved_value" },
    });
  }

  // Approved, but under a different domain.
  if (parent) {
    const elsewhere = options.vocabulary.find(
      (v) => v.domain !== parent.domain && v.subDomains.some((s) => foldText(s) === foldedInput),
    );
    if (elsewhere) {
      return unresolved<string>({
        ruleCode: "SUBDOMAIN_WRONG_DOMAIN",
        severity: "out_of_vocabulary",
        originalValue: original,
        confidence: null,
        detail: {
          field: options.field,
          filedUnder: parent.domain,
          belongsTo: elsewhere.domain,
        },
      });
    }
  }

  const candidates = bestCandidates(original, inScope);
  const top = candidates[0];
  if (top && top.score >= options.nearMatchThreshold) {
    return proposed(top.value, {
      ruleCode: "SUBDOMAIN_NOT_IN_METHODOLOGY",
      severity: "out_of_vocabulary",
      originalValue: original,
      proposedValue: top.value,
      confidence: Number(top.score.toFixed(4)),
      detail: { field: options.field, candidates, withinDomain: parent?.domain ?? null },
    });
  }

  return unresolved<string>({
    ruleCode: "SUBDOMAIN_NOT_IN_METHODOLOGY",
    severity: "out_of_vocabulary",
    originalValue: original,
    confidence: null,
    detail: { field: options.field, candidates, withinDomain: parent?.domain ?? null },
  });
}
