/**
 * A scored study in every region, so the map shows real bands instead of grey.
 *
 *   pnpm tsx prisma/seed-scored-regions.ts [orgName]
 *
 * Builds the full chain per region — Study -> Need -> Survey -> PublicSurveyLink
 * -> SurveyResponses -> ScoreRollups — and stops there. It does NOT write
 * PriorityScore rows. The band on the map is the FR-003 engine's output, and a
 * hand-written score would be a number wearing a methodology version that no
 * methodology produced. Score them afterwards with the platform's own endpoint,
 * as a Data Analyst (the only tenant role holding priorityScoring:create):
 *
 *   POST /api/needs/:needId/priority-score
 *
 * What this script actually controls is the engine's INPUT. Severity per region
 * is varied deliberately so the output spans all four bands and the colours,
 * legend and filters can be seen working.
 *
 * Two things that are easy to get wrong, both of which produce a silently
 * unscorable need:
 *
 *  1. ScoreRollup.villageId must be the EMPTY STRING. PriorityService looks up
 *     rollups with `villageId: ""`, so a rollup keyed by village name — which
 *     is what seed-scored-study.ts writes — is never found, severity comes back
 *     null, and the need scores "low" off a fraction of its factors.
 *  2. The need must be linked to a governorate. The map places needs through
 *     needGovernorates; one without is counted but never drawn.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { NeedSource, UserStatus } from '../src/generated/prisma';
import { prisma, supervisor, setOrg, disconnectAll } from './seed-helpers';

const ORG_NAME = process.argv[2] ?? 'RIO Test Organisation';

/**
 * Target severity per band, chosen against DEFAULT_THRESHOLDS in
 * scoring.ts (critical >= 80, high >= 70, medium >= 40, low < 40) with room
 * either side so a small weighting change does not reclassify everything.
 *
 * Every factor this script can set is set to the same target, so the engine's
 * weighted mean lands on it regardless of how the weights are configured.
 * Getting there by tuning one factor against the others would break the first
 * time someone edits the weights in Config.
 */
/**
 * These severities are CALIBRATED, not the band thresholds themselves.
 *
 * Severity is one factor of nine at 20% of the weight, so it does not equal
 * the score: measured against the live config, severity 100 produces 82 and
 * severity 26 produces 35. Two factors pull every need down and neither is a
 * mistake — data_confidence scores 6 because the seeded data is clean (it
 * rewards uncertainty, being a reason to go and look), and strategic_alignment
 * scores 33. Setting severity to the band threshold therefore lands a whole
 * band low, which is exactly what the first run of this script did.
 *
 * Re-measure with POST /api/needs/:id/priority-score and read `factors` if the
 * weights in Config are ever edited.
 */
const PROFILES = [
  { band: 'critical', severity: 100, urgency: 'immediate', people: 42000, villages: 12 }, // -> 82
  { band: 'high', severity: 92, urgency: 'this_cycle', people: 16000, villages: 7 }, // -> 72
  { band: 'medium', severity: 60, urgency: 'next_cycle', people: 5000, villages: 3 }, // -> 54
  { band: 'low', severity: 26, urgency: 'no_fixed_timeline', people: 900, villages: 1 }, // -> 35
] as const;

/**
 * One theme every seeded need carries, so the `frequency` factor has evidence.
 * It measures how many OTHER needs share a theme — with nothing shared it
 * scores a hard 0 at 10% of the weight, which drags a genuinely critical need
 * two bands down for no reason other than being the only need in the system.
 */
const SHARED_THEME = 'basic service provision';

/** Rotated across regions so all four colours appear, weighted towards the
 *  middle — a map where a third of the country is critical teaches nobody
 *  what critical looks like. */
const BAND_ORDER = [0, 1, 2, 1, 3, 0, 2, 1, 3, 2, 1, 0, 3];

const TOPICS = [
  { domain: 'Water & Sanitation', sub: 'Drinking Water Access', title: 'Drinking water reliability' },
  { domain: 'Health', sub: 'Primary Healthcare Access', title: 'Access to primary healthcare' },
  { domain: 'Education', sub: 'School Capacity', title: 'Secondary school capacity' },
  { domain: 'Infrastructure', sub: 'Road Access', title: 'All-weather road access' },
];

async function main(): Promise<void> {
  const org = await supervisor.organisation.findFirst({
    where: { name: { contains: ORG_NAME, mode: 'insensitive' } },
    select: { id: true, name: true, regionId: true },
  });
  if (!org) throw new Error(`No organisation matching "${ORG_NAME}".`);

  const author = await supervisor.user.findFirst({
    where: { orgId: org.id, status: UserStatus.active },
    select: { id: true },
  });
  if (!author) throw new Error(`"${org.name}" has no active user to author these.`);

  const mv = await prisma.methodologyVersion.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!mv) throw new Error('No MethodologyVersion — run the imports first.');

  // Access/availability questions drive the service-gap factor. Without
  // QUESTION rollups for these the factor is unmeasured and the mean is taken
  // over fewer components.
  const accessQuestions = await prisma.question.findMany({
    where: { methodologyVersionId: mv.id, analyticalCategory: { in: ['Access', 'Availability'] } },
    select: { questionId: true },
    take: 6,
  });

  const regions = await supervisor.region.findMany({
    select: {
      id: true,
      name: true,
      governorates: {
        select: {
          id: true,
          name: true,
          centers: { where: { latitude: { not: null } }, select: { id: true }, take: 1 },
        },
        take: 1,
      },
    },
    orderBy: { code: 'asc' },
  });

  let made = 0;
  for (const [i, region] of regions.entries()) {
    const gov = region.governorates[0];
    if (!gov) {
      console.log(`  ${region.name.padEnd(24)} no governorate on record — skipped`);
      continue;
    }
    const profile = PROFILES[BAND_ORDER[i % BAND_ORDER.length]!]!;
    const topic = TOPICS[i % TOPICS.length]!;
    const title = `${topic.title} — ${region.name}`;

    const already = await supervisor.study.findFirst({
      where: { orgId: org.id, title: { startsWith: `Scored Assessment — ${region.name}` } },
      select: { id: true },
    });
    if (already) {
      console.log(`  ${region.name.padEnd(24)} already seeded — skipped`);
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await setOrg(tx as never, org.id);

      const maxCycle = await tx.study.aggregate({
        where: { orgId: org.id },
        _max: { cycleNumber: true },
      });

      const study = await tx.study.create({
        data: {
          orgId: org.id,
          title: `Scored Assessment — ${region.name}`,
          cycleNumber: (maxCycle._max.cycleNumber ?? 0) + 1,
          methodologyVersionId: mv.id,
          createdBy: author.id,
          studyGovernorates: { create: [{ orgId: org.id, governorateId: gov.id }] },
          ...(gov.centers[0]
            ? { studyCenters: { create: [{ orgId: org.id, centerId: gov.centers[0].id }] } }
            : {}),
        },
      });

      const need = await tx.need.create({
        data: {
          orgId: org.id,
          studyId: study.id,
          title,
          statement:
            `Assessment of ${topic.domain.toLowerCase()} provision across ${gov.name}, ` +
            `${region.name}. Seeded demonstration data: the figures below are inputs to ` +
            `the priority engine, not observations from a real field survey.`,
          domain: topic.domain,
          subDomain: topic.sub,
          source: NeedSource.field_survey,
          urgency: profile.urgency,
          affectedPeople: profile.people,
          // Feeds the geographic_coverage factor; without it that 8% of the
          // weight is unmeasured.
          village: Array.from(
            { length: profile.villages },
            (_, v) => `${gov.name} settlement ${v + 1}`,
          ),
          themes: [SHARED_THEME, topic.domain.toLowerCase()],
          createdBy: author.id,
          // Without this the need is counted but never drawn on the map.
          needGovernorates: { create: [{ orgId: org.id, governorateId: gov.id }] },
          ...(gov.centers[0]
            ? { needCenters: { create: [{ orgId: org.id, centerId: gov.centers[0].id }] } }
            : {}),
        },
      });

      // Need.domain/subDomain always needs a matching NeedDomain row, the way
      // the real classification path writes both together — without it the
      // need vanishes from every domain breakdown despite being classified.
      await tx.needDomain.create({
        data: { needId: need.id, orgId: org.id, domain: topic.domain, subDomain: topic.sub },
      });

      const survey = await tx.survey.create({
        data: {
          orgId: org.id,
          needId: need.id,
          studyId: study.id,
          title: `${region.name} Needs Survey`,
          status: 'PUBLISHED',
          methodologyVersion: mv.version,
          publishedAt: new Date(),
          approverComments: 'System-generated seed data',
          createdBy: author.id,
        },
      });

      const link = await tx.publicSurveyLink.create({
        data: {
          orgId: org.id,
          needId: need.id,
          studyId: study.id,
          label: `${region.name} public link`,
          token: randomBytes(16).toString('hex'),
          createdBy: author.id,
        },
      });

      const responses = 24 + (i % 5) * 4;
      await tx.surveyResponse.createMany({
        data: Array.from({ length: responses }, (_, r) => ({
          orgId: org.id,
          needId: need.id,
          studyId: study.id,
          surveyLinkId: link.id,
          contact: `respondent-${i + 1}-${r + 1}@seed.local`,
          gender: (r % 2 === 0 ? 'female' : 'male') as 'female' | 'male',
          settlementType: (r % 3 === 0 ? 'urban' : 'rural') as 'urban' | 'rural',
          regionId: region.id,
          answers: {},
        })),
      });

      const common = {
        orgId: org.id,
        studyId: study.id,
        surveyId: survey.id,
        // Empty string, not the village name — see the header.
        villageId: '',
        methodologyVersionId: mv.id,
        calculationVersion: 'seed-regions-v1',
      };

      await tx.scoreRollup.create({
        data: {
          ...common,
          rollupLevel: 'OVERALL',
          entityId: 'OVERALL',
          entityNameSnapshot: 'Overall',
          severityScore: profile.severity,
          validResponseCount: responses,
          excludedResponseCount: 0,
          dontKnowCount: 2,
          // Low and steady: this feeds the inverted data-confidence factor, so
          // a high rate here would push a calm region into a high band on the
          // strength of bad data rather than real need.
          dontKnowRate: 0.06,
          notApplicableCount: 0,
          confidenceLevel: 'STANDARD',
        },
      });

      if (accessQuestions.length > 0) {
        await tx.scoreRollup.createMany({
          data: accessQuestions.map((q) => ({
            ...common,
            rollupLevel: 'QUESTION' as const,
            entityId: q.questionId,
            entityNameSnapshot: q.questionId,
            severityScore: profile.severity,
            validResponseCount: responses,
            excludedResponseCount: 0,
            dontKnowCount: 1,
            dontKnowRate: 0.04,
            notApplicableCount: 0,
            confidenceLevel: 'STANDARD' as const,
          })),
        });
      }

      console.log(
        `  ${region.name.padEnd(24)} ${gov.name.padEnd(18)} severity ${String(profile.severity).padStart(3)} -> expect ${profile.band}`,
      );
      made++;
    });
  }

  console.log(`\n${made} region(s) seeded in "${org.name}".`);
  console.log('They are still UNSCORED. Run the engine over them to colour the map:');
  console.log('  POST /api/needs/:needId/priority-score   (as a Data Analyst)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(disconnectAll);
