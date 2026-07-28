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
export async function aggregateDemographics(
  tenant: TenantPrismaService,
  studyId: string,
  villageId: string,
): Promise<Demographics | null> {
  return tenant.runInOrgContext(async (tx) => {
    const where: { studyId: string; village?: { has: string } } = { studyId };
    if (villageId) where.village = { has: villageId };

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
