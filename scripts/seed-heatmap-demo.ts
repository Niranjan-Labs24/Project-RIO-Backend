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

async function seedForOrg(orgId: string, createdBy: string): Promise<void> {
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
    console.warn(`Org ${orgId}: fewer than ${VILLAGE_COUNT} Centers exist — skipping.`);
    return;
  }

  // PUBLISHED, not just "oldest" — same convention as PriorityService/
  // CenterAggregationService. The retired v1.0 baseline has zero Questions
  // tagged with a `kpi` name; only the live v5.0 methodology does, so
  // picking the wrong one here silently starved every KPI rollup below
  // down to the synthetic fallback.
  const mv = await prisma.methodologyVersion.findFirst({
    where: { status: "PUBLISHED" },
    orderBy: { createdAt: "desc" },
  });
  if (!mv) throw new Error("No PUBLISHED MethodologyVersion found — run the main seed / imports first.");

  await prisma.$transaction(async (tx) => {
    await setOrg(tx, orgId);

    // RIO-FR-005 (Jagan's clarification mail, 2026-09-21) — re-seeding
    // rather than skipping when this org's demo study already exists: the
    // heat map side panel now drills into per-KPI detail (Survey +
    // ScoreRollup), which the original version of this script never wrote.
    // An org seeded before that change would show "no KPI data" on every
    // cell, so the old demo study is replaced rather than left stale.
    const existing = await tx.study.findFirst({ where: { orgId, title: STUDY_TITLE } });
    if (existing) await tx.study.delete({ where: { id: existing.id } });

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
      // Up to 2 real Question Bank KPIs per domain, so the heat map side
      // panel's per-KPI breakdown (Domain, KPI, Severity Score, Analytical
      // Category, ...) has something real to join against instead of
      // coming back empty. Falls back to a synthetic single KPI if this
      // methodology version has none tagged with a `kpi` name for the
      // domain — better than no KPI rows at all for the demo.
      const kpiQuestions = await tx.question.findMany({
        where: { methodologyVersionId: mv.id, domain, kpi: { not: null } },
        take: 2,
      });

      for (let i = 0; i < centers.length; i++) {
        const score = scores[i];
        const center = centers[i];
        const village = VILLAGE_POOL[i] ?? center.name;
        const level = score !== null ? levelFor(score) : null;
        const gapType = level ? gapTypeFor(level) : null;

        const need = await tx.need.create({
          data: {
            studyId: study.id,
            orgId,
            title: `${domain} — ${village} (heat map demo)`,
            statement: `Demo Need seeded to exercise the ${domain} x ${village} heat map cell.`,
            village: [village],
            source: "manual_entry",
            domain,
            // RIO-FR-005 (Q12) — analyst-entered on the View Metrics screen
            // in real usage; set directly here since this is seed data, not
            // exercising that workflow.
            gapType,
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
        if (score === null || level === null || gapType === null) continue;

        // Equity Flag — alternate rather than a fixed value, so the demo
        // shows both Yes and No in the KPI panel (client's worked example
        // has one of each across two KPIs).
        const equityFlagged = i % 2 === 0;

        await tx.priorityScore.create({
          data: {
            orgId,
            needId: need.id,
            studyId: study.id,
            overallScore: score,
            level,
            gapType,
            equityFlagged,
            factors: { seededForHeatMapDemo: true },
            cycleNote: level === "critical" || level === "high" ? "Acute — Cycle 1, awaiting trend" : null,
            approvedBy: createdBy,
            approvedAt: new Date(),
          },
        });

        const survey = await tx.survey.create({
          data: {
            orgId,
            needId: need.id,
            studyId: study.id,
            title: `${domain} — ${village} survey (heat map demo)`,
            status: "PUBLISHED",
            methodologyVersion: mv.version,
            createdBy,
          },
        });

        // Per-KPI severity rollups — the heat map side panel's actual data
        // source (CenterAggregationService.kpiBreakdownForDomain). Slight
        // spread around the Need's own score so KPIs under one domain/cell
        // aren't all identical, same idea as the client's worked example
        // (80.17 and 64.40 under one domain/village).
        const kpiSource =
          kpiQuestions.length > 0
            ? kpiQuestions
            : [{ questionId: `${domain}-synthetic-kpi`, kpi: `${domain} composite indicator`, analyticalCategory: null }];
        for (const [kpiIndex, question] of kpiSource.entries()) {
          const kpiScore = Math.max(0, Math.min(100, score - kpiIndex * 12 + (i % 3) * 4));
          await tx.scoreRollup.create({
            data: {
              orgId,
              studyId: study.id,
              surveyId: survey.id,
              villageId: "",
              methodologyVersionId: mv.id,
              rollupLevel: "KPI",
              entityId: question.questionId,
              entityNameSnapshot: question.kpi ?? question.questionId,
              severityScore: kpiScore,
              validResponseCount: 40,
              excludedResponseCount: 0,
              dontKnowCount: kpiIndex === 0 ? 2 : 9,
              dontKnowRate: kpiIndex === 0 ? 0.05 : 0.23,
              notApplicableCount: 0,
              confidenceLevel: kpiIndex === 0 ? "STANDARD" : "LOW",
              calculationVersion: "seed-heatmap-demo",
            },
          });
        }
      }
    }

    console.log(`Seeded "${STUDY_TITLE}" (${study.id}) for org ${orgId} — ${DOMAINS.length} domains x ${centers.length} villages.`);
  });
}

async function main(): Promise<void> {
  // RIO-FR-005 (Jagan's clarification mail, 2026-09-21) — every NGO admin
  // account, not just admin@demo-ngo.org, so whichever org logs into UAT
  // can open Village Comparison and see this demo data, not just one.
  const admins = await supervisor.user.findMany({
    where: { roleId: "role_ngo_admin" },
    distinct: ["orgId"],
    orderBy: { createdAt: "asc" },
  });
  if (admins.length === 0) throw new Error("No role_ngo_admin users found — run the main seed first.");

  for (const admin of admins) {
    await seedForOrg(admin.orgId, admin.id);
  }
}

main()
  .then(() => Promise.all([prisma.$disconnect(), supervisor.$disconnect()]))
  .catch(async (e) => {
    console.error(e);
    await Promise.all([prisma.$disconnect(), supervisor.$disconnect()]);
    process.exit(1);
  });
