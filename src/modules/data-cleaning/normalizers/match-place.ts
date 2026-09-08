// RIO-FR-002 / Q12 — "village and place names matched to the official
// geographic reference".
//
// Village names are stored as free text (Need.village is a String[]), and the
// same village is spelled several ways — the client said so themselves in Q2,
// when explaining why they could not hand us a coordinate file keyed on names.
// This resolver is what connects that free text to the seeded Center /
// Governorate master data.
//
// It never writes. A confident match becomes a PROPOSED center code on a flag;
// an unconfident one becomes a shortlist; nothing at all becomes
// VILLAGE_UNMATCHED. That last case is deliberately a visible flag rather than
// a silent drop, for the reason the client gave in Q4 about the map: no need
// should disappear from the totals because its village did not match.
//
// The reference list is passed in — it comes from the Center table, which the
// adapter reads. Pure function, no database, fully testable.

import { foldText, trigramSimilarity } from "./fold-text";
import { classifyPresence, type DontKnowTreatment } from "./dont-know";
import {
  clean,
  missing,
  unresolved,
  proposed,
  type NormalizationResult,
} from "./types";

export interface PlaceReference {
  /** Center.code — the stable identifier, e.g. "0101-001". */
  code: string;
  /** Center.name as seeded. */
  name: string;
  /** Governorate name, shown to the reviewer to tell same-named places apart. */
  governorate?: string;
}

export interface PlaceMatchOptions {
  field: string;
  required: boolean;
  dontKnowTreatment: DontKnowTreatment;
  reference: PlaceReference[];
  /**
   * At or above this, a single best match is proposed. Below it but at or
   * above proposeThreshold, a shortlist is offered instead.
   */
  acceptThreshold: number;
  proposeThreshold: number;
  maxCandidates: number;
}

export interface PlaceCandidate {
  code: string;
  name: string;
  governorate: string | null;
  score: number;
}

/**
 * Two candidates this close together are not distinguishable by score, and
 * picking the higher one would be arbitrary. Real Saudi center names collide
 * often enough (several "الفرعة", several "الخالدية") that this is a routine
 * case, not an edge one.
 */
const AMBIGUITY_MARGIN = 0.02;

function rank(raw: string, reference: PlaceReference[], limit: number): PlaceCandidate[] {
  const folded = foldText(raw);
  if (!folded) return [];
  return reference
    .map((ref) => ({
      code: ref.code,
      name: ref.name,
      governorate: ref.governorate ?? null,
      score: trigramSimilarity(folded, foldText(ref.name)),
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => (b.score - a.score) || a.code.localeCompare(b.code))
    .slice(0, limit);
}

/**
 * Resolve one free-text village name to a Center code.
 *
 * The returned `value` is the CENTER CODE, not the name: the code is what
 * every downstream join needs, and it is stable where the name is not.
 * `proposedValue` on the flag is the code too, so accepting a flag is a
 * single unambiguous write.
 */
export function matchPlace(
  raw: string | null | undefined,
  options: PlaceMatchOptions,
): NormalizationResult<string> {
  const presence = classifyPresence(raw, options.dontKnowTreatment);
  if (presence === "excluded") return clean<string>(null);
  if (presence === "absent") {
    return options.required ? missing<string>(options.field) : clean<string>(null);
  }

  const original = raw!.trim();
  const foldedInput = foldText(original);

  // An exact folded match against a single reference entry is not a guess —
  // it is the same name written differently, which is precisely what folding
  // exists to recognise.
  const exactMatches = options.reference.filter((ref) => foldText(ref.name) === foldedInput);
  if (exactMatches.length === 1) {
    const match = exactMatches[0]!;
    // ...but if the stored text is ALREADY the reference spelling, there is
    // nothing to standardize. Proposing it anyway puts a no-op in the
    // reviewer's queue: original and proposed are the same string, accepting
    // changes nothing, and the reviewer learns to distrust the queue. Caught
    // by fr002:verify-review against real data, where center 0707-001 is
    // itself named "Qiyal".
    if (match.name === original) return clean(match.code);
    return proposed(match.code, {
      ruleCode: "VILLAGE_NEAR_MATCH",
      severity: "non_standard",
      originalValue: original,
      proposedValue: match.code,
      confidence: 1,
      detail: {
        field: options.field,
        matchedName: match.name,
        governorate: match.governorate ?? null,
        reason: "exact_match_after_folding",
      },
    });
  }

  const candidates = rank(original, options.reference, options.maxCandidates);
  const top = candidates[0];

  // Several reference entries share this name — a real and common case, and
  // one only a person with local knowledge can settle.
  if (exactMatches.length > 1) {
    return unresolved<string>({
      ruleCode: "VILLAGE_AMBIGUOUS",
      severity: "out_of_vocabulary",
      originalValue: original,
      confidence: null,
      detail: {
        field: options.field,
        reason: "same_name_in_several_governorates",
        candidates: exactMatches.slice(0, options.maxCandidates).map((ref) => ({
          code: ref.code,
          name: ref.name,
          governorate: ref.governorate ?? null,
          score: 1,
        })),
      },
    });
  }

  if (!top || top.score < options.proposeThreshold) {
    return unresolved<string>({
      ruleCode: "VILLAGE_UNMATCHED",
      severity: "out_of_vocabulary",
      originalValue: original,
      confidence: null,
      detail: { field: options.field, candidates },
    });
  }

  const runnerUp = candidates[1];
  if (runnerUp && top.score - runnerUp.score < AMBIGUITY_MARGIN) {
    return unresolved<string>({
      ruleCode: "VILLAGE_AMBIGUOUS",
      severity: "out_of_vocabulary",
      originalValue: original,
      confidence: null,
      detail: {
        field: options.field,
        reason: "candidates_too_close_to_separate",
        candidates,
      },
    });
  }

  if (top.score >= options.acceptThreshold) {
    return proposed(top.code, {
      ruleCode: "VILLAGE_NEAR_MATCH",
      severity: "non_standard",
      originalValue: original,
      proposedValue: top.code,
      confidence: Number(top.score.toFixed(4)),
      detail: {
        field: options.field,
        matchedName: top.name,
        governorate: top.governorate,
        candidates,
      },
    });
  }

  // Above propose, below accept: there is something to show, but not enough to
  // put a single answer in front of the reviewer as though it were settled.
  return unresolved<string>({
    ruleCode: "VILLAGE_NEAR_MATCH",
    severity: "out_of_vocabulary",
    originalValue: original,
    confidence: Number(top.score.toFixed(4)),
    detail: { field: options.field, candidates },
  });
}
