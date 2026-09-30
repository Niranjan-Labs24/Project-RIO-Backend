import type { Prisma } from '../../generated/prisma';

// UAT-09 — a survey inherits Target Sector, geography and methodology version
// from its parent Study rather than having them re-entered in the Survey
// Builder. Methodology version is stored on the survey itself (it drives
// question-bank scoping and scoring); the rest is read live from the Study
// while the survey is editable and frozen into Survey.inheritedSnapshot at
// publish.

export interface GeoName {
  name: string;
  nameAr: string | null;
}

export interface InheritedFromStudy {
  studyId: string;
  studyTitle: string;
  targetSector: string | null;
  regions: GeoName[];
  governorates: GeoName[];
  centers: GeoName[];
  villages: string[];
}

type Tx = Prisma.TransactionClient;

/** Live values from the Study, or null if the Study is gone/invisible. */
export async function loadStudyInheritance(tx: Tx, studyId: string): Promise<InheritedFromStudy | null> {
  const study = await tx.study.findUnique({
    where: { id: studyId },
    select: {
      id: true,
      title: true,
      targetSector: true,
      villages: true,
      studyGovernorates: {
        select: {
          governorate: {
            select: { name: true, nameAr: true, region: { select: { name: true, nameAr: true } } },
          },
        },
      },
      studyCenters: { select: { center: { select: { name: true, nameAr: true } } } },
    },
  });
  if (!study) return null;

  const regions = new Map<string, GeoName>();
  for (const sg of study.studyGovernorates) {
    const r = sg.governorate.region;
    if (r && !regions.has(r.name)) regions.set(r.name, { name: r.name, nameAr: r.nameAr });
  }
  const byName = (a: GeoName, b: GeoName) => a.name.localeCompare(b.name);
  return {
    studyId: study.id,
    studyTitle: study.title,
    targetSector: study.targetSector,
    regions: [...regions.values()].sort(byName),
    governorates: study.studyGovernorates.map((sg) => ({ name: sg.governorate.name, nameAr: sg.governorate.nameAr })).sort(byName),
    centers: study.studyCenters.map((sc) => ({ name: sc.center.name, nameAr: sc.center.nameAr })).sort(byName),
    villages: [...study.villages],
  };
}

/** The Study's methodology version label (e.g. "v5.0"), or null if unset. */
export async function loadStudyMethodologyVersion(tx: Tx, studyId: string): Promise<string | null> {
  const study = await tx.study.findUnique({
    where: { id: studyId },
    select: { methodologyVersion: { select: { version: true } } },
  });
  return study?.methodologyVersion?.version ?? null;
}

/**
 * Plain-text summary kept in Survey.geographicCoverage — the pre-UAT-09 free
 * text field that approval views, audit entries and exports already read.
 * Derived from the Study now instead of typed by the Researcher.
 */
export function summarizeGeography(inherited: InheritedFromStudy): string {
  const parts = [
    inherited.regions.length ? `Region: ${inherited.regions.map((r) => r.name).join(', ')}` : null,
    inherited.governorates.length ? `Governorates: ${inherited.governorates.map((g) => g.name).join(', ')}` : null,
    inherited.centers.length ? `Centers: ${inherited.centers.map((c) => c.name).join(', ')}` : null,
    inherited.villages.length ? `Villages: ${inherited.villages.join(', ')}` : null,
  ].filter((p): p is string => p !== null);
  const text = parts.join(' · ');
  // Column is VARCHAR(500); a very large study scope is truncated, never rejected.
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/** Narrow a stored snapshot (Json) back to its shape; null if absent/malformed. */
export function parseInheritedSnapshot(value: Prisma.JsonValue | null): InheritedFromStudy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.studyId !== 'string' || !Array.isArray(v.governorates)) return null;
  return value as unknown as InheritedFromStudy;
}
