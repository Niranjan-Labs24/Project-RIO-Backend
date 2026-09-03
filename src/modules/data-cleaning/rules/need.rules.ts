// RIO-FR-002 — the rules that apply to a Need.
//
// Pure: a plain record in, flags out. No database, no Nest. The adapter reads
// the row and the context; this decides what is wrong with it.

import type { CleaningContext } from "../cleaning-context.service";
import type { PendingFlag } from "../data-cleaning.types";
import { matchPlace, normalizeDomain, normalizeSubDomain } from "../normalizers";

export interface NeedCleaningInput {
  id: string;
  title: string;
  statement: string;
  village: string[];
  domain: string | null;
  subDomain: string | null;
  source: string | null;
  affectedPopulation: number | null;
  urgency: string | null;
  gapType: string | null;
  /** Center ids already linked through NeedCenter. */
  centerIds: string[];
  /** Governorate ids already linked through NeedGovernorate. */
  governorateIds: string[];
}

function missingFlag(entityId: string, field: string): PendingFlag {
  return {
    entityType: "need",
    entityId,
    rowNumber: null,
    field,
    ruleCode: "MISSING_REQUIRED",
    severity: "missing",
    originalValue: null,
    proposedValue: null,
    confidence: null,
    detail: { field },
  };
}

/**
 * A Need's geography is satisfied by EITHER a free-text village or a linked
 * Center/Governorate.
 *
 * This distinction matters more than it looks: NeedsService.create defaults a
 * Need's governorates and centers from its Study when the form leaves them
 * blank, so most needs carry real, structured geography while `village` stays
 * empty. Treating an empty `village` as missing geography would flag ~90% of
 * this platform's needs for something that is not actually absent, and a queue
 * that is 90% false alarm is a queue nobody reads.
 */
function hasGeography(need: NeedCleaningInput): boolean {
  return (
    need.village.some((v) => v.trim().length > 0) ||
    need.centerIds.length > 0 ||
    need.governorateIds.length > 0
  );
}

export function evaluateNeed(
  need: NeedCleaningInput,
  context: CleaningContext,
): PendingFlag[] {
  const flags: PendingFlag[] = [];
  const { settings } = context;
  const required = new Set(settings.requiredNeedFields);
  const soft = new Set(settings.softNeedFields);

  // ── Missing core fields (AC 1) ──────────────────────────────────────────
  if (required.has("title") && !need.title?.trim()) flags.push(missingFlag(need.id, "title"));
  if (required.has("statement") && !need.statement?.trim()) {
    flags.push(missingFlag(need.id, "statement"));
  }
  if (required.has("geography") && !hasGeography(need)) {
    flags.push(missingFlag(need.id, "geography"));
  }
  // `source` is system-assigned on every creation path and can only be absent
  // on a row that predates the column. Checked anyway: the point of a required
  // -field list is that it is honoured, not that it is trusted.
  if (required.has("source") && !need.source?.trim()) flags.push(missingFlag(need.id, "source"));

  if (soft.has("affectedPopulation") && need.affectedPopulation === null) {
    flags.push(missingFlag(need.id, "affectedPopulation"));
  }
  if (soft.has("urgency") && !need.urgency?.trim()) flags.push(missingFlag(need.id, "urgency"));
  if (soft.has("gapType") && !need.gapType?.trim()) flags.push(missingFlag(need.id, "gapType"));

  // ── Domain / sub-domain against the approved methodology list (Q12) ─────
  //
  // Only when a vocabulary actually loaded. With no reference data every value
  // would look out-of-vocabulary, which says something about the deployment,
  // not about the need.
  let resolvedDomain: string | null = need.domain;
  if (context.vocabulary.length > 0) {
    const domainResult = normalizeDomain(need.domain, {
      field: "domain",
      // A missing domain is reported by this call, not by the block above —
      // normalizeDomain returns MISSING_REQUIRED itself when the field is
      // required and empty, so checking it in both places would raise the
      // same flag twice.
      required: required.has("domain"),
      dontKnowTreatment: settings.dontKnowTreatment,
      vocabulary: context.vocabulary,
      nearMatchThreshold: settings.classificationNearMatchThreshold,
    });
    resolvedDomain = domainResult.value;
    if (domainResult.flag) {
      flags.push({
        entityType: "need",
        entityId: need.id,
        rowNumber: null,
        field: "domain",
        ...domainResult.flag,
      });
    }

    if (need.subDomain?.trim()) {
      const subResult = normalizeSubDomain(need.subDomain, {
        field: "subDomain",
        required: false,
        dontKnowTreatment: settings.dontKnowTreatment,
        vocabulary: context.vocabulary,
        nearMatchThreshold: settings.classificationNearMatchThreshold,
        resolvedDomain,
      });
      if (subResult.flag) {
        flags.push({
          entityType: "need",
          entityId: need.id,
          rowNumber: null,
          field: "subDomain",
          ...subResult.flag,
        });
      }
    }
  } else if (required.has("domain") && !need.domain?.trim()) {
    // No vocabulary loaded, so the value cannot be checked against the
    // approved list — but "there is no domain at all" is still knowable, and
    // is the finding AC 1 asks for.
    flags.push(missingFlag(need.id, "domain"));
  }

  // ── Village names against the geographic reference (Q12) ────────────────
  //
  // One flag per village VALUE, not one per need: a need can name several
  // villages (Need.village is an array) and each is separately matchable or
  // not. The field is suffixed with the index so two unmatched villages on one
  // need are two rows, and re-running updates each in place rather than having
  // them overwrite one another through the partial unique index.
  if (context.places.length > 0) {
    need.village.forEach((village, index) => {
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
        flags.push({
          entityType: "need",
          entityId: need.id,
          rowNumber: null,
          field: `village[${index}]`,
          ...result.flag,
        });
      }
    });
  }

  return flags;
}
