import type { TenantPrismaService } from "../../../tenancy/tenant-prisma.service";
import type { Demographics } from "../report-content.types";

const GENDER_LABEL: Record<string, string> = {
  male: "Male",
  female: "Female",
  other: "Other",
  prefer_not_to_say: "Prefer not to say",
};
const SETTLEMENT_LABEL: Record<string, string> = { rural: "Rural", urban: "Urban" };

// Real demographics from survey responses — gender (Gender enum) and rural/urban
// (SettlementType enum). Each series is real when captured and simply omitted
// (empty) when not, so the demographic charts degrade gracefully. Shared by the
// real provider and saveReportFromSummary so both agree. Returns null only when
// neither series has any data.
// Scope: RPT01 describes ONE survey, and a Survey belongs to exactly one Need,
// so its respondents are the Need's respondents. Filtering by studyId pulled
// every sibling survey's respondents into this report's gender breakdown — the
// same leak already fixed for evidence. Study-wide scopes (SECTOR / REGION /
// EXECUTIVE) legitimately span the study and pass `{ studyId }`.
export async function aggregateDemographics(
  tenant: TenantPrismaService,
  scope: { needId: string } | { studyId: string },
  villageId: string,
  // RPT06: the villages a REGION covers. Without it a region report's gender
  // split came from the whole study, so the chart contradicted the rows above
  // it. A single villageId still wins — it is the narrower ask.
  villageIds?: string[],
): Promise<Demographics | null> {
  return tenant.runInOrgContext(async (tx) => {
    const where: Record<string, unknown> = { ...scope };
    if (villageId) where.village = { has: villageId };
    else if (villageIds?.length) where.village = { hasSome: villageIds };

    const [genderRows, settlementRows] = await Promise.all([
      tx.surveyResponse.groupBy({ by: ["gender"], where, _count: true }),
      tx.surveyResponse.groupBy({ by: ["settlementType"], where, _count: true }),
    ]);

    const gender = genderRows
      .filter((r) => r.gender)
      .map((r) => ({ label: GENDER_LABEL[r.gender as string] ?? String(r.gender), count: r._count }));
    const rural = settlementRows
      .filter((r) => r.settlementType)
      .map((r) => ({ label: SETTLEMENT_LABEL[r.settlementType as string] ?? String(r.settlementType), count: r._count }));

    return gender.length > 0 || rural.length > 0 ? { gender, rural } : null;
  });
}
