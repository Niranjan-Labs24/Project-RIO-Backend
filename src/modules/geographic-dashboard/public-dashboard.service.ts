import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import type {
  PublicDashboardDomain,
  PublicDashboardDomainScore,
  PublicDashboardGovernorate,
  PublicDashboardRegion,
  PublicDashboardResponse,
} from './public-dashboard.types';

/** A counted need, reduced to what the averages need. */
interface CountedNeed {
  id: string;
  score: number;
  domainCode: string | null;
  governorates: { code: string; name: string; nameAr: string | null; regionId: string }[];
}

interface Bucket {
  needs: Map<string, number>;
  byDomain: Map<string, Map<string, number>>;
}

function emptyBucket(): Bucket {
  return { needs: new Map(), byDomain: new Map() };
}

function add(bucket: Bucket, need: CountedNeed): void {
  // Keyed by need id, so a need listed under two governorates of one region
  // still counts once for that region.
  bucket.needs.set(need.id, need.score);
  if (need.domainCode) {
    const d = bucket.byDomain.get(need.domainCode) ?? new Map<string, number>();
    d.set(need.id, need.score);
    bucket.byDomain.set(need.domainCode, d);
  }
}

function average(scores: Iterable<number>): number {
  const list = [...scores];
  return Math.round(list.reduce((a, b) => a + b, 0) / list.length);
}

function summarise(bucket: Bucket, order: string[]) {
  const domains: PublicDashboardDomainScore[] = order
    .filter((code) => bucket.byDomain.has(code))
    .map((code) => {
      const d = bucket.byDomain.get(code)!;
      return { code, score: average(d.values()), needCount: d.size };
    });
  return { score: average(bucket.needs.values()), needCount: bucket.needs.size, domains };
}

const normalise = (s: string) => s.trim().toLowerCase();

@Injectable()
export class PublicDashboardService {
  constructor(private readonly tenant: TenantPrismaService) {}

  /**
   * The NCNP Geographic Dashboard's data, made public as averages.
   *
   * Which needs count — all four must hold:
   *   1. approved by a human reviewer (`reviewer_approved`). Most needs are
   *      not, and an unreviewed AI classification is not something to
   *      publish (decided with Ayush, 2026-10-08).
   *   2. not merged into another need, so a duplicate is not counted twice —
   *      same rule as the NCNP map.
   *   3. scored, and placed in at least one governorate.
   *   4. not from an imported prior study. The public archive's rule is that
   *      an import's needs never appear publicly, not even as counts.
   *
   * The score is the need's latest priority score, the reviewer's override
   * when there is one. Read through `runAsSupervisor`, the same read-only
   * cross-organisation connection the NCNP view and the public archive use.
   */
  async get(): Promise<PublicDashboardResponse> {
    const { domains, needs, regions } = await this.tenant.runAsSupervisor(async (tx) => {
      const [domains, rows, regions] = await Promise.all([
        tx.domain.findMany({
          where: { isActive: true },
          select: { code: true, name: true, nameAr: true },
          orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
        }),
        tx.need.findMany({
          where: {
            status: 'reviewer_approved',
            mergedIntoNeedId: null,
            study: { isHistorical: false },
            priorityScores: { some: {} },
            needGovernorates: { some: {} },
          },
          select: {
            id: true,
            domain: true,
            priorityScores: {
              select: { overallScore: true, overrideScore: true },
              orderBy: { scoredAt: 'desc' },
              take: 1,
            },
            needGovernorates: {
              select: {
                governorate: {
                  select: { code: true, name: true, nameAr: true, regionId: true },
                },
              },
            },
          },
        }),
        tx.region.findMany({ select: { id: true, code: true, name: true, nameAr: true } }),
      ]);
      return { domains, needs: rows, regions };
    });

    // Need.domain is the domain *name* copied onto the need, not a key, so
    // match on the name in either language.
    const codeByName = new Map<string, string>();
    for (const d of domains) {
      codeByName.set(normalise(d.name), d.code);
      if (d.nameAr) codeByName.set(normalise(d.nameAr), d.code);
    }

    const counted: CountedNeed[] = needs.flatMap((n) => {
      const s = n.priorityScores[0];
      if (!s) return [];
      return [
        {
          id: n.id,
          score: s.overrideScore ?? s.overallScore,
          domainCode: n.domain ? (codeByName.get(normalise(n.domain)) ?? null) : null,
          governorates: n.needGovernorates.map((g) => g.governorate),
        },
      ];
    });

    const order = domains.map((d) => d.code);
    const regionById = new Map(regions.map((r) => [r.id, r]));
    const govBuckets = new Map<string, { gov: CountedNeed['governorates'][number]; bucket: Bucket }>();
    const regionBuckets = new Map<string, Bucket>();

    for (const need of counted) {
      for (const gov of need.governorates) {
        const entry = govBuckets.get(gov.code) ?? { gov, bucket: emptyBucket() };
        add(entry.bucket, need);
        govBuckets.set(gov.code, entry);

        const rb = regionBuckets.get(gov.regionId) ?? emptyBucket();
        add(rb, need);
        regionBuckets.set(gov.regionId, rb);
      }
    }

    const governorates: PublicDashboardGovernorate[] = [...govBuckets.values()]
      .filter(({ gov }) => regionById.has(gov.regionId))
      .map(({ gov, bucket }) => ({
        code: gov.code,
        name: gov.name,
        nameAr: gov.nameAr,
        regionCode: regionById.get(gov.regionId)!.code,
        ...summarise(bucket, order),
      }))
      .sort((a, b) => a.code.localeCompare(b.code));

    const regionList: PublicDashboardRegion[] = [...regionBuckets.entries()]
      .filter(([id]) => regionById.has(id))
      .map(([id, bucket]) => {
        const r = regionById.get(id)!;
        return {
          code: String(r.code),
          regionCode: r.code,
          name: r.name,
          nameAr: r.nameAr,
          ...summarise(bucket, order),
        };
      })
      .sort((a, b) => a.regionCode - b.regionCode);

    const publicDomains: PublicDashboardDomain[] = domains.map((d) => ({
      code: d.code,
      name: d.name,
      nameAr: d.nameAr,
    }));

    return {
      domains: publicDomains,
      regions: regionList,
      governorates,
      totals: {
        needs: counted.length,
        regions: regionList.length,
        governorates: governorates.length,
      },
      generatedAt: new Date().toISOString(),
    };
  }
}
