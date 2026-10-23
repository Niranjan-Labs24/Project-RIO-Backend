import type { TenantPrismaService } from "../../../tenancy/tenant-prisma.service";

// Region-scoped breakdown for RPT06.
//
// The report used to read the study-wide rollup and print it under a region's
// name, which is right for a single-region study and wrong the moment anyone
// compares two regions — the same number would appear under both. This resolves
// the region to its actual villages and reads their own rows.
//
// The chain the schema forces, since villages are free-text on Need rather than
// master data under Center:
//
//   Region -> Governorate[] -> NeedGovernorate -> Need (this study)
//          -> Need.village[] -> ScoreRollup.villageId / VillagePriorityAssessment.villageId
//
// Aggregation across villages follows the methodology workbook's own
// convention (METH - Domain Comparison): a cross-village AVERAGE, reported
// alongside the MAXIMUM, because a governorate can average Low while hiding a
// critical village. Reporting the average alone is the masking the workbook's
// no-masking rule exists to prevent.

export interface VillageBreakdownRow {
  village: string;
  governorate: string;
  needCount: number;
  responseCount: number;
  severityScore: number | null;
  priorityScore: number | null;
  priorityStatus: string | null;
}

export interface GovernorateBreakdownRow {
  governorate: string;
  governorateCode: string;
  villageCount: number;
  needCount: number;
  responseCount: number;
  /** Cross-village mean of the villages that were scored. Null when none were. */
  severityScore: number | null;
  /** Worst single village. Carried so the mean cannot hide a critical one. */
  maxVillageSeverity: number | null;
  priorityScore: number | null;
}

export interface RegionBreakdown {
  regionId: string | null;
  regionName: string | null;
  governorates: GovernorateBreakdownRow[];
  villages: VillageBreakdownRow[];
  /** Needs in the study with no governorate link — counted, never dropped. */
  unmappedNeedCount: number;
  /** Villages named on a need but with no rollup row yet. */
  unscoredVillages: string[];
}

interface Query {
  studyId: string;
  surveyId: string;
  methodologyVersionId: string;
  /** Omitted = every governorate the study touches, still grouped by region. */
  regionId?: string;
}

const mean = (values: number[]): number | null =>
  values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : null;

export async function loadRegionBreakdown(
  tenant: TenantPrismaService,
  query: Query,
): Promise<RegionBreakdown> {
  return tenant.runInOrgContext(async (tx) => {
    // 1. Needs in this study, with their governorate links and villages.
    const needs = await tx.need.findMany({
      where: { studyId: query.studyId },
      select: {
        id: true,
        village: true,
        needGovernorates: {
          select: {
            governorate: {
              select: {
                id: true,
                code: true,
                name: true,
                regionId: true,
                region: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });

    // 2. Narrow to the requested region. A need can name several governorates,
    //    so it belongs to the region if ANY of them does.
    const inRegion = (n: (typeof needs)[number]): boolean =>
      !query.regionId || n.needGovernorates.some((g) => g.governorate.regionId === query.regionId);

    const scoped = needs.filter(inRegion);
    const unmappedNeedCount = scoped.filter((n) => n.needGovernorates.length === 0).length;

    // Region identity, taken from the data rather than assumed from the filter,
    // so a regionId matching nothing in this study reports an empty region
    // instead of a confidently-labelled empty one.
    const firstRegion = scoped
      .flatMap((n) => n.needGovernorates.map((g) => g.governorate.region))
      .find((r) => !query.regionId || r.id === query.regionId);

    // 3. Village -> governorate, and the needs behind each village.
    interface Bucket {
      governorate: string;
      governorateCode: string;
      needIds: Set<string>;
    }
    const villageBuckets = new Map<string, Bucket>();
    const governorateNeeds = new Map<string, { name: string; code: string; needIds: Set<string>; villages: Set<string> }>();

    for (const need of scoped) {
      const govs = need.needGovernorates
        .map((g) => g.governorate)
        .filter((g) => !query.regionId || g.regionId === query.regionId);

      for (const gov of govs) {
        const entry = governorateNeeds.get(gov.id) ?? {
          name: gov.name,
          code: gov.code,
          needIds: new Set<string>(),
          villages: new Set<string>(),
        };
        entry.needIds.add(need.id);
        for (const v of need.village) entry.villages.add(v);
        governorateNeeds.set(gov.id, entry);
      }

      // A village inherits the first governorate its need names. Needs spanning
      // several governorates are rare and the alternative — counting one
      // village under two governorates — would double-count it in the totals.
      const primary = govs[0];
      for (const village of need.village) {
        const bucket = villageBuckets.get(village) ?? {
          governorate: primary?.name ?? "Not linked",
          governorateCode: primary?.code ?? "",
          needIds: new Set<string>(),
        };
        bucket.needIds.add(need.id);
        villageBuckets.set(village, bucket);
      }
    }

    const villageNames = [...villageBuckets.keys()];
    const allNeedIds = scoped.map((n) => n.id);

    // 4. The per-village figures. Empty study short-circuits: an `in: []`
    //    query is a pointless round trip.
    const [rollups, assessments, responses] = await Promise.all([
      villageNames.length
        ? tx.scoreRollup.findMany({
            where: {
              studyId: query.studyId,
              surveyId: query.surveyId,
              methodologyVersionId: query.methodologyVersionId,
              rollupLevel: "OVERALL",
              villageId: { in: villageNames },
            },
            select: { villageId: true, severityScore: true, validResponseCount: true },
          })
        : Promise.resolve([]),
      villageNames.length
        ? tx.villagePriorityAssessment.findMany({
            where: {
              studyId: query.studyId,
              surveyId: query.surveyId,
              methodologyVersionId: query.methodologyVersionId,
              villageId: { in: villageNames },
            },
            select: { villageId: true, priorityScore: true, priorityStatus: true },
          })
        : Promise.resolve([]),
      allNeedIds.length
        ? tx.surveyResponse.findMany({
            where: { needId: { in: allNeedIds } },
            select: { village: true },
          })
        : Promise.resolve([]),
    ]);

    const severityByVillage = new Map(
      rollups.map((r) => [r.villageId ?? "", r.severityScore === null ? null : Number(r.severityScore)]),
    );
    const priorityByVillage = new Map(
      assessments.map((a) => [a.villageId, { score: Number(a.priorityScore), status: a.priorityStatus }]),
    );

    // Responses carry their own village array, so they attribute directly
    // rather than being divided evenly across a need's villages.
    const responsesByVillage = new Map<string, number>();
    for (const response of responses) {
      for (const v of response.village ?? []) {
        responsesByVillage.set(v, (responsesByVillage.get(v) ?? 0) + 1);
      }
    }

    const villages: VillageBreakdownRow[] = villageNames
      .map((village) => {
        const bucket = villageBuckets.get(village)!;
        const priority = priorityByVillage.get(village) ?? null;
        return {
          village,
          governorate: bucket.governorate,
          needCount: bucket.needIds.size,
          responseCount: responsesByVillage.get(village) ?? 0,
          severityScore: severityByVillage.get(village) ?? null,
          priorityScore: priority ? priority.score : null,
          priorityStatus: priority ? priority.status : null,
        };
      })
      // Worst first — the point of the report is which places need attention.
      // Unscored villages sort last rather than being treated as severity 0.
      .sort((a, b) => (b.severityScore ?? -1) - (a.severityScore ?? -1) || a.village.localeCompare(b.village));

    const governorates: GovernorateBreakdownRow[] = [...governorateNeeds.entries()]
      .map(([, entry]) => {
        const own = villages.filter((v) => v.governorate === entry.name);
        const scored = own.map((v) => v.severityScore).filter((s): s is number => s !== null);
        const priorities = own.map((v) => v.priorityScore).filter((s): s is number => s !== null);
        return {
          governorate: entry.name,
          governorateCode: entry.code,
          villageCount: entry.villages.size,
          needCount: entry.needIds.size,
          responseCount: own.reduce((sum, v) => sum + v.responseCount, 0),
          severityScore: mean(scored),
          maxVillageSeverity: scored.length ? Math.max(...scored) : null,
          priorityScore: mean(priorities),
        };
      })
      .sort((a, b) => (b.severityScore ?? -1) - (a.severityScore ?? -1) || a.governorate.localeCompare(b.governorate));

    return {
      regionId: query.regionId ?? firstRegion?.id ?? null,
      regionName: firstRegion?.name ?? null,
      governorates,
      villages,
      unmappedNeedCount,
      unscoredVillages: villages.filter((v) => v.severityScore === null).map((v) => v.village),
    };
  });
}
