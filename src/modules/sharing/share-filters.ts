import { BadRequestException } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma";
import { PLATFORM_ADMIN_REGISTRATION_NUMBER } from "../organizations/organizations.service";

/**
 * UAT SHR-01 — narrowing the study / report request pickers by where a study
 * is (region > governorate > centre) and what it covers (domain > sub-domain),
 * so a requester can find what to ask for instead of guessing an entity name.
 * Shared by study sharing and report sharing so both pickers filter alike.
 */
export interface ShareFilters {
  regionId?: string;
  governorateId?: string;
  centerId?: string;
  domain?: string;
  subDomain?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseShareFilters(query: Record<string, unknown>): ShareFilters {
  const id = (key: string): string | undefined => {
    const value = query[key];
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string" || !UUID.test(value)) {
      throw new BadRequestException({ error: { code: "INVALID_FILTER", message: `${key} must be a UUID.` } });
    }
    return value;
  };
  const text = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
  };
  return {
    regionId: id("regionId"),
    governorateId: id("governorateId"),
    centerId: id("centerId"),
    domain: text("domain"),
    subDomain: text("subDomain"),
  };
}

export function hasShareFilters(f: ShareFilters): boolean {
  return Boolean(f.regionId || f.governorateId || f.centerId || f.domain || f.subDomain);
}

/** Studies matching every filter given; an empty filter matches all. */
export function studyMatchesFilters(f: ShareFilters): Prisma.StudyWhereInput {
  const and: Prisma.StudyWhereInput[] = [];
  if (f.regionId) and.push({ studyGovernorates: { some: { governorate: { regionId: f.regionId } } } });
  if (f.governorateId) and.push({ studyGovernorates: { some: { governorateId: f.governorateId } } });
  if (f.centerId) and.push({ studyCenters: { some: { centerId: f.centerId } } });
  if (f.domain || f.subDomain) {
    and.push({
      needs: {
        some: {
          needDomains: {
            some: { ...(f.domain ? { domain: f.domain } : {}), ...(f.subDomain ? { subDomain: f.subDomain } : {}) },
          },
        },
      },
    });
  }
  return and.length ? { AND: and } : {};
}

/**
 * Entities a request can be addressed to: active, not the caller, and never
 * the platform's own system-accounts home (it owns no studies or reports and
 * was listed as if it were an entity).
 */
export function requestableOrgWhere(callerOrgId: string, query: string | undefined): Prisma.OrganisationWhereInput {
  return {
    id: { not: callerOrgId },
    isActive: true,
    registrationNumber: { not: PLATFORM_ADMIN_REGISTRATION_NUMBER },
    ...(query ? { name: { contains: query, mode: "insensitive" } } : {}),
  };
}
