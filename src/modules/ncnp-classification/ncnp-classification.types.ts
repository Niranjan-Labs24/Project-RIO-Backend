// GEN-07 (UAT v1.4) — NCNP Non-Profit Entity Classification.
// level: 1 = Group, 2 = Level A, 3 = Level B. An organisation stores Level B.
export type NcnpClassificationLevel = 1 | 2 | 3;

export interface NcnpClassificationItem {
  id: string;
  code: string;
  level: NcnpClassificationLevel;
  parentId: string | null;
  name: string;
  definition: string | null;
  supervisingEntity: string | null;
  displayOrder: number;
  isActive: boolean;
}

/** An organisation's classification, resolved from its stored Level B item. */
export interface OrganisationClassification {
  groupId: string;
  groupName: string;
  levelAId: string;
  levelAName: string;
  levelBId: string;
  levelBName: string;
  definition: string | null;
}
