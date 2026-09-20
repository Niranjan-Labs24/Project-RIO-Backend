import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { pgSslFromEnv } from "../src/prisma/pg-ssl";

// One-off demo-data seed so the Village Comparison Heat Map (RIO-FR-005,
// client-confirmed 2026-09-20) can actually be looked at with a realistic
// spread of tiers — the live demo org's real Needs happen to cluster in one
// tier, which made it impossible to see Critical/High/Medium/Low/unscored
// side by side. Idempotent: re-running skips if the demo study already
// exists. Run: pnpm tsx scripts/seed-heatmap-demo.ts
//
// Deliberately its own Study ("Heat Map Demo — Village Comparison") rather
// than adding to an existing one, so this is easy to find and delete later
// without touching real seeded data other screens/tests depend on.
//
// Village naming: two earlier versions of this script both got this wrong.
// V1 used fictional village labels ("Abu Rakab", "Abu Jilal", ...) unrelated
// to whichever real KSA Geographic Reference Centres the query happened to
// return for this org (e.g. "Al-Ha'ir", "Banban") — a real place name and a
// made-up one stacked on the same card, confusing on review. V2 "fixed"
// that by setting village = Centre name, which just traded one problem for
// another: the same name appearing twice on one card reads as a data bug,
// not real data — no field researcher types the Centre's own name into the
// free-text village field. This version instead draws from `VILLAGE_POOL`,
// real village names already used elsewhere in this same org's actual
// (non-demo) Need records — confirmed live against the database, not
// invented — so each demo Need's village is realistic free text, distinct
// from its Centre, exactly like production data.
const VILLAGE_POOL = ["Ad-Dawadmi", "Ad-Dilam", "Al-Kharj", "Qurayyat", "Sakaka", "Taif Gardens"];

const ssl = pgSslFromEnv();
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.APP_DATABASE_URL, ssl }),
});
const supervisor = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl }),
});

async function setOrg(tx: { $executeRawUnsafe: (s: string) => Promise<number> }, orgId: string) {
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${orgId}', true)`);
}

const STUDY_TITLE = "Heat Map Demo — Village Comparison";
const VILLAGE_COUNT = 6; // enough columns to force horizontal scroll on a normal screen

const DOMAINS = [
  "Health",
  "Education",
  "Water & Sanitation",
  "Energy & Environment",
  "Livelihood",
  "Infrastructure",
  "Social Development",
  "Culture",
  "Governance & Services",
];

// Scores chosen against DEFAULT_THRESHOLDS (critical >= 80, high >= 70,
// medium >= 40, low < 40 — see src/modules/priority/scoring.ts) so the tier
// each one lands in is unambiguous at a glance. 6 columns.
const SCORE_GRID: Record<string, (number | null)[]> = {
  "Health": [88, 45, 22, null, 63, 34],
  "Education": [35, 91, 68, 52, 78, 47],
  "Water & Sanitation": [95, 60, null, 15, 44, 72],
  "Energy & Environment": [50, 28, 84, 71, 19, 39],
  "Livelihood": [18, 77, 41, 90, 33, 65],
  "Infrastructure": [65, null, 30, 82, 57, 24],
  "Social Development": [42, 20, 15, 58, 25, 87],
  "Culture": [null, 55, 12, 38, 66, 43],
  "Governance & Services": [80, 63, 47, null, 51, 29],
};

// Demo affected-population figures per centre — so the card's "Affected
// Population" section shows real numbers instead of "—" (RIO-FR-005 Round 4:
// this field is null, not 0, until at least one Need carries a value; the
// demo needs at least one Need per centre to set it).
const AFFECTED_PEOPLE = [1200, 850, 2100, 640, 1500, 980];
const AFFECTED_HOUSEHOLDS = [210, 140, 380, 95, 260, 165];

function levelFor(score: number): "critical" | "high" | "medium" | "low" {
  if (score >= 80) return "critical";
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function gapTypeFor(level: string): string {
  // Any fixed value from GapType is fine here — this demo data isn't
  // exercising gap-type logic, only the heat map's score/tier rendering.
  return level === "critical" ? "acute" : "chronic";
}

async function main(): Promise<void> {
  const admin = await supervisor.user.findFirst({ where: { email: "admin@demo-ngo.org" } });
  if (!admin) throw new Error("admin@demo-ngo.org not found — run the main seed first.");
  const orgId = admin.orgId;
  const createdBy = admin.id;

  const existing = await supervisor.study.findFirst({ where: { orgId, title: STUDY_TITLE } });
  if (existing) {
    console.log(`Already seeded: "${STUDY_TITLE}" (${existing.id}). Nothing to do.`);
    return;
  }

  // Reuse Centers already linked to this org (falls back to any Centers if
  // the org has fewer than VILLAGE_COUNT of its own) so NeedCenter's FK is
  // always satisfied and the heat map's columns show real Centre/
  // governorate labels, not the "(unplaced)" bucket.
  const orgCenters = await supervisor.organisationCenter.findMany({
    where: { orgId },
    include: { center: true },
    take: VILLAGE_COUNT,
  });
  const centers =
    orgCenters.length >= VILLAGE_COUNT
      ? orgCenters.map((oc) => oc.center)
      : await supervisor.center.findMany({ take: VILLAGE_COUNT });
  if (centers.length < VILLAGE_COUNT) {
    throw new Error(`Fewer than ${VILLAGE_COUNT} Centers exist in the KSA Geographic Reference.`);
  }

  const mv = await prisma.methodologyVersion.findFirst({ orderBy: { createdAt: "asc" } });
  if (!mv) throw new Error("No MethodologyVersion found — run the main seed / imports first.");

  await prisma.$transaction(async (tx) => {
    await setOrg(tx, orgId);

    const maxRow = await tx.study.findFirst({
      where: { orgId },
      orderBy: { cycleNumber: "desc" },
      select: { cycleNumber: true },
    });
    const cycleNumber = (maxRow?.cycleNumber ?? 0) + 1;

    const study = await tx.study.create({
      data: {
        orgId,
        title: STUDY_TITLE,
        cycleNumber,
        studyType: "Assessment",
        status: "active",
        createdBy,
      },
    });

    for (const domain of DOMAINS) {
      const scores = SCORE_GRID[domain] ?? centers.map(() => null);
      for (let i = 0; i < centers.length; i++) {
        const score = scores[i];
        const center = centers[i];
        const village = VILLAGE_POOL[i] ?? center.name;
        const need = await tx.need.create({
          data: {
            studyId: study.id,
            orgId,
            title: `${domain} — ${village} (heat map demo)`,
            statement: `Demo Need seeded to exercise the ${domain} x ${village} heat map cell.`,
            village: [village],
            source: "manual_entry",
            domain,
            status: "reviewer_approved",
            createdBy,
            // Only the first domain's Need per centre carries the
            // affected-population figures — the field aggregates by SUM
            // across every Need at a centre (CenterAggregationService), so
            // setting it on every Need would inflate the total 9x.
            affectedPeople: domain === DOMAINS[0] ? AFFECTED_PEOPLE[i] : null,
            affectedHouseholds: domain === DOMAINS[0] ? AFFECTED_HOUSEHOLDS[i] : null,
            needCenters: { create: [{ orgId, centerId: center.id }] },
          },
        });

        // Leave this cell unscored on purpose — the heat map's "not yet
        // scored" / grey-cell case (client's clarification never said
        // whether an unscored cell should be hidden; showing it as a
        // distinct grey state is the safer default — see conversation).
        if (score === null) continue;

        const level = levelFor(score);
        await tx.priorityScore.create({
          data: {
            orgId,
            needId: need.id,
            studyId: study.id,
            overallScore: score,
            level,
            gapType: gapTypeFor(level),
            factors: { seededForHeatMapDemo: true },
            approvedBy: createdBy,
            approvedAt: new Date(),
          },
        });
      }
    }

    console.log(`Seeded "${STUDY_TITLE}" (${study.id}) — ${DOMAINS.length} domains x ${centers.length} villages.`);
    console.log("Centres used:", centers.map((c) => c.name).join(", "));
    console.log("Villages used:", centers.map((_, i) => VILLAGE_POOL[i] ?? centers[i].name).join(", "));
  });
}

main()
  .then(() => Promise.all([prisma.$disconnect(), supervisor.$disconnect()]))
  .catch(async (e) => {
    console.error(e);
    await Promise.all([prisma.$disconnect(), supervisor.$disconnect()]);
    process.exit(1);
  });
