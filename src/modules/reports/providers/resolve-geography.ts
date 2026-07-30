import type { UnitGeo } from "../need-record.types";

// ONE canonical geography resolver. The report header, the AI snapshot and the
// coverage tiles each used to derive place names their own way — the AI
// narrative named the STUDY's governorates ("Abha, Ahad Rufaydah") while the
// header named the NEED's ("Abha"), in the same document. Everything now reads
// this.
//
// Pure: the caller supplies rows it has already read inside its own org-scoped
// transaction, so this never opens a nested one.

export interface GeographyRows {
  /** The Need's own village list; falls back to the Study's when empty. */
  needVillages: string[];
  studyVillages: string[];
  governorates: Array<{ id: string; name: string; regionId: string; regionName: string }>;
  centers: Array<{ id: string; name: string }>;
  /** Narrows the scope to a single village when the report is filtered. */
  villageId?: string;
}

export function buildUnitGeo(rows: GeographyRows): UnitGeo {
  const { needVillages, studyVillages, governorates, centers, villageId } = rows;

  // Villages this survey covers: the Need's own list, falling back to the
  // Study's when the Need inherits the study scope — the same rule the coverage
  // block uses, so the two counts cannot disagree.
  const allVillages = (needVillages.length ? needVillages : studyVillages).filter(Boolean);
  const villages = villageId ? allVillages.filter((v) => v === villageId) : allVillages;

  const governorateNames = [...new Set(governorates.map((g) => g.name))];
  const regionNames = [...new Set(governorates.map((g) => g.regionName))];
  const regionIds = [...new Set(governorates.map((g) => g.regionId))];

  return {
    // A single region is named; several are joined rather than one being picked
    // arbitrarily, which is how a multi-governorate study came to be labelled
    // with one governorate's region.
    regionId: regionIds.length === 1 ? regionIds[0]! : null,
    regionName: regionNames.length ? regionNames.join(", ") : null,
    governorateIds: governorates.map((g) => g.id),
    governorateNames,
    centerIds: centers.map((c) => c.id),
    centerNames: [...new Set(centers.map((c) => c.name))],
    villages,
    scopeLabel: buildScopeLabel({ governorateNames, regionNames, villages, villageId }),
  };
}

/** e.g. "Abha, Aseer — all 3 village(s) (consolidated)" or "… — Al-Athab". */
export function buildScopeLabel(input: {
  governorateNames: string[];
  regionNames: string[];
  villages: string[];
  villageId?: string;
}): string {
  const { governorateNames, regionNames, villages, villageId } = input;
  const place = [governorateNames.join(", "), regionNames.join(", ")].filter(Boolean).join(", ");
  const head = place || "Scope not linked to a governorate";
  if (villageId) return `${head} — ${villageId}`;
  if (villages.length === 0) return `${head} — no villages recorded`;
  return `${head} — all ${villages.length} village(s) (consolidated)`;
}
