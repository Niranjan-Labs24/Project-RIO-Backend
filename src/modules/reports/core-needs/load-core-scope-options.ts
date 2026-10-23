// The choices the Generate dialog offers for RPT18: the areas the study's
// needs actually cover at each scope level, and the methodology's domains.
// Only places with at least one need are offered — an area the study never
// touched would produce an empty report. Each area lists the studies that
// cover it, so the dialog can ask for the area first and then offer only
// those studies (client structure v2: scope, then study).

import type { Prisma } from "../../../generated/prisma";
import { normalizeDomainKey } from "../../priority/priority-v2.service";
import { villageKey, villageLabels } from "./load-core-needs";

export interface ScopeOption {
  id: string;
  name: string;
  nameAr: string | null;
  studyIds: string[];
}

export interface CoreScopeOptions {
  regions: ScopeOption[];
  governorates: Array<ScopeOption & { regionId: string }>;
  centres: Array<ScopeOption & { governorateId: string }>;
  villages: Array<{ name: string; governorateId: string | null; studyIds: string[] }>;
  domains: Array<{ key: string; name: string; nameAr: string | null }>;
  /** Studies with at least one need: the ones a Kingdom report can use. */
  studyIds: string[];
}

/** For one study (the Generate dialog) or several (the NCNP report). */
export async function loadCoreScopeOptions(tx: Prisma.TransactionClient, studyIds: string | string[]): Promise<CoreScopeOptions> {
  const ids = Array.isArray(studyIds) ? studyIds : [studyIds];
  const versions = await tx.study.findMany({
    where: { id: { in: ids }, methodologyVersionId: { not: null } },
    select: { methodologyVersionId: true },
    distinct: ['methodologyVersionId'],
  });
  const needs = await tx.need.findMany({
    where: { studyId: { in: ids }, mergedIntoNeedId: null },
    select: {
      studyId: true,
      village: true,
      needGovernorates: { select: { governorate: { include: { region: true } } } },
      needCenters: { select: { center: true } },
    },
  });
  const regions = new Map<string, ScopeOption>();
  const governorates = new Map<string, ScopeOption & { regionId: string }>();
  const centres = new Map<string, ScopeOption & { governorateId: string }>();
  const villages = new Map<
    string,
    { name: string; governorateId: string | null; governorateName: string | null; studyIds: string[] }
  >();
  const withNeeds = new Set<string>();
  // Adds the study to an option once, creating the option on first sight.
  const cover = <T extends { studyIds: string[] }>(
    map: Map<string, T>,
    key: string,
    make: () => Omit<T, 'studyIds'>,
    studyId: string,
  ) => {
    const o = map.get(key) ?? ({ ...make(), studyIds: [] } as unknown as T);
    if (!o.studyIds.includes(studyId)) o.studyIds.push(studyId);
    map.set(key, o);
  };
  for (const n of needs) {
    withNeeds.add(n.studyId);
    for (const { governorate: g } of n.needGovernorates) {
      cover(regions, g.region.id, () => ({ id: g.region.id, name: g.region.name, nameAr: g.region.nameAr }), n.studyId);
      cover(
        governorates,
        g.id,
        () => ({ id: g.id, name: g.name, nameAr: g.nameAr, regionId: g.regionId }),
        n.studyId,
      );
    }
    for (const { center: c } of n.needCenters)
      cover(
        centres,
        c.id,
        () => ({ id: c.id, name: c.name, nameAr: c.nameAr, governorateId: c.governorateId }),
        n.studyId,
      );
    // One village per governorate and name, ignoring case and spacing; the
    // label follows the report's (villageLabels).
    const gov = n.needGovernorates[0]?.governorate ?? null;
    for (const v of n.village)
      if (v.trim())
        cover(
          villages,
          villageKey(gov?.id ?? null, v),
          () => ({ name: v.trim(), governorateId: gov?.id ?? null, governorateName: gov?.name ?? null }),
          n.studyId,
        );
  }

  const versionIds = versions.map((v) => v.methodologyVersionId!);
  const domainRows = versionIds.length
    ? await tx.question.findMany({
        where: { methodologyVersionId: { in: versionIds }, usedInMvp: true },
        select: { domain: true, excludedFromNineDomainIndex: true },
      })
    : [];
  const outside = new Set(
    domainRows.filter((r) => r.excludedFromNineDomainIndex).map((r) => r.domain),
  );
  const names = [...new Set(domainRows.map((r) => r.domain))].filter((d) => !outside.has(d));
  const ar = new Map(
    (await tx.domain.findMany({ select: { name: true, nameAr: true } })).map((d) => [
      d.name,
      d.nameAr,
    ]),
  );

  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
  return {
    regions: [...regions.values()].sort(byName),
    governorates: [...governorates.values()].sort(byName),
    centres: [...centres.values()].sort(byName),
    villages: (() => {
      const labels = villageLabels(
        [...villages].map(([key, v]) => ({ key, typedName: v.name, governorateName: v.governorateName })),
      );
      return [...villages]
        .map(([key, v]) => ({ name: labels.get(key) ?? v.name, governorateId: v.governorateId, studyIds: v.studyIds }))
        .sort(byName);
    })(),
    domains: names.map((name) => ({
      key: normalizeDomainKey(name),
      name,
      nameAr: ar.get(name) ?? null,
    })),
    studyIds: [...withNeeds],
  };
}

/** Every area any of the organisation's live studies covers — the dialog's
 *  first step, before a study is chosen. */
export async function loadOrgCoreScopeOptions(
  tx: Prisma.TransactionClient,
  orgId: string,
): Promise<CoreScopeOptions> {
  const studies = await tx.study.findMany({
    where: { orgId, archivedAt: null },
    select: { id: true },
  });
  return loadCoreScopeOptions(
    tx,
    studies.map((s) => s.id),
  );
}
