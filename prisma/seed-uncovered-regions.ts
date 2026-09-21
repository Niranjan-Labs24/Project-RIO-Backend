/**
 * Gives every region at least one need, so the geographic dashboard has
 * something to show everywhere instead of a handful of coloured areas.
 *
 *   pnpm tsx prisma/seed-uncovered-regions.ts [orgName]
 *
 * Only touches regions that currently have none — a region already carrying
 * needs is left exactly as it is, so this can be re-run safely and never
 * inflates a real figure.
 *
 * It creates the needs and their geography links, and stops there. It does NOT
 * write PriorityScore rows: a score is the output of the FR-003 engine over a
 * need's severity, population, urgency and the rest, and a hand-written one
 * would be a number with a methodology version attached to it that no
 * methodology produced. The needs land unscored — which the map draws in grey
 * and labels "not yet scored", truthfully — and are scored by running the
 * platform's own endpoint against them:
 *
 *   POST /api/needs/:needId/priority-score
 *
 * Writes through the OWNER connection with the RLS org context set, the same
 * way seed-helpers.ts does: needs and studies are FORCE row-level security, so
 * an insert without app.current_org_id matches no policy and is refused.
 */
import 'dotenv/config';
import { NeedSource, UserStatus } from '../src/generated/prisma';
import { prisma, supervisor, setOrg, disconnectAll } from './seed-helpers';

const ORG_NAME = process.argv[2] ?? 'Demo NGO';

/** One need per uncovered region, worded for the region it lands in rather
 *  than repeated verbatim — a dashboard full of identical titles is no more
 *  useful than an empty one. */
const TEMPLATES: Array<{ title: string; statement: string; domain: string }> = [
  {
    title: 'Irregular water supply in outlying settlements',
    domain: 'Water & Sanitation',
    statement:
      'Households in the outlying settlements report that piped water arrives on an irregular schedule, and store it in uncovered containers between deliveries. The interval between deliveries has lengthened over the past two years with no published schedule residents can plan around.',
  },
  {
    title: 'Distance to the nearest primary health centre',
    domain: 'Health',
    statement:
      'The nearest primary health centre is far enough that routine appointments are commonly postponed, and antenatal visits in particular are missed. Clinic records show attendance falling away sharply with distance from the centre.',
  },
  {
    title: 'Secondary school places short of demand',
    domain: 'Education',
    statement:
      'Secondary school places fall short of the number of pupils completing primary education locally, and families report sending older children to relatives in larger towns to continue their schooling.',
  },
];

async function main(): Promise<void> {
  const org = await supervisor.organisation.findFirst({
    where: { name: { contains: ORG_NAME, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (!org) throw new Error(`No organisation matching "${ORG_NAME}".`);

  // A need's author has to be a real user of the org.
  const author = await supervisor.user.findFirst({
    where: { orgId: org.id, status: UserStatus.active },
    select: { id: true },
  });
  if (!author) throw new Error(`"${org.name}" has no active user to record as the author.`);

  // Which regions have nothing? Counted the same way the map counts: through a
  // need's governorates, ignoring needs retired as duplicates.
  const regions = await supervisor.region.findMany({
    select: {
      id: true,
      code: true,
      name: true,
      governorates: {
        select: {
          id: true,
          name: true,
          centers: { where: { latitude: { not: null } }, select: { id: true }, take: 1 },
          _count: { select: { needGovernorates: true } },
        },
      },
    },
    orderBy: { code: 'asc' },
  });

  const uncovered = regions.filter((r) =>
    r.governorates.every((g) => g._count.needGovernorates === 0),
  );

  if (uncovered.length === 0) {
    console.log('Every region already has at least one need. Nothing to do.');
    return;
  }

  console.log(`Regions with no needs: ${uncovered.map((r) => r.name).join(', ')}
`);

  // One study, not one per region. `studies` is UNIQUE (org_id, cycle_number),
  // so a study *is* a cycle for its organisation — creating one per region
  // would invent three cycles to hold three needs. A single assessment that
  // covers the uncovered regions is both legal and the truer description.
  const lastCycle = await supervisor.study.aggregate({
    where: { orgId: org.id },
    _max: { cycleNumber: true },
  });
  const cycleNumber = (lastCycle._max.cycleNumber ?? 0) + 1;

  const targets = uncovered
    .map((region) => {
      const gov =
        region.governorates.find((g) => g.centers.length > 0) ?? region.governorates[0];
      return gov ? { region, gov, center: gov.centers[0] } : null;
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  for (const r of uncovered) {
    if (!targets.some((t) => t.region.id === r.id)) {
      console.log(`  ${r.name}: no governorate on record — skipped`);
    }
  }
  if (targets.length === 0) return;

  await prisma.$transaction(async (tx) => {
    await setOrg(tx as never, org.id);

    const study = await tx.study.create({
      data: {
        orgId: org.id,
        title: `Baseline Needs Assessment — ${targets.map((t) => t.region.name).join(', ')}`,
        cycleNumber,
        createdBy: author.id,
        studyGovernorates: {
          create: targets.map((t) => ({ orgId: org.id, governorateId: t.gov.id })),
        },
        studyCenters: {
          create: targets
            .filter((t) => t.center)
            .map((t) => ({ orgId: org.id, centerId: t.center!.id })),
        },
      },
    });

    for (const [i, t] of targets.entries()) {
      const tpl = TEMPLATES[i % TEMPLATES.length]!;
      await tx.need.create({
        data: {
          orgId: org.id,
          studyId: study.id,
          title: `${tpl.title} (${t.region.name})`,
          statement: tpl.statement,
          domain: tpl.domain,
          source: NeedSource.manual_entry,
          createdBy: author.id,
          needGovernorates: { create: [{ orgId: org.id, governorateId: t.gov.id }] },
          ...(t.center
            ? { needCenters: { create: [{ orgId: org.id, centerId: t.center.id }] } }
            : {}),
        },
      });
      console.log(
        `  ${t.region.name.padEnd(22)} -> ${t.gov.name}${t.center ? '' : '  (no centre coordinate)'}`,
      );
    }

    console.log(`
Study "${study.title}" (cycle ${cycleNumber}) with ${targets.length} need(s).`);
  });

  console.log(
    'They are unscored, so the map shows them grey until the priority engine ' +
      'runs: POST /api/needs/:needId/priority-score, or the Priority Dashboard.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(disconnectAll);
