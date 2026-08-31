import { Logger } from "@nestjs/common";
import type { AppLocale } from "../../i18n/locale";
import type { TenantPrismaService } from "../../tenancy/tenant-prisma.service";

/**
 * English reference name → the client's Arabic wording, for the vocabulary a
 * report quotes verbatim: domains, sub-domains, regions, governorates, centres.
 *
 * WHY THIS IS LOADED AT EXPORT TIME
 *
 * These names are baked into stored report content — a table cell says
 * "Education" because that is what the generator wrote when the report was
 * produced. Translating them at generation time would mean the English and
 * Arabic editions of one approved report were separately generated documents,
 * which is exactly what the export-time design exists to avoid (RIO-RPT-001
 * AC 2/AC 3). Substituting at render time instead means:
 *
 *  - both editions carry identical figures under one approval, and
 *  - every report ALREADY in the database renders Arabic names the moment the
 *    vocabulary is supplied, with nothing to regenerate.
 *
 * WHY WHOLE-STRING MATCHING IS SAFE HERE
 *
 * Same argument as the closed value vocabulary in localise-doc: an entry is
 * substituted only when a whole label or cell equals it exactly. A partial or
 * substring match would eventually rewrite a fragment of prose that happened to
 * contain a domain name.
 *
 * A name with no `nameAr` yet is simply absent from the map, so it renders in
 * English — visibly incomplete rather than silently wrong.
 */
export type ReferenceNameMap = Record<string, string>;

const logger = new Logger("ReferenceNames");

/** Reads the reference tables through the supervisor connection.
 *
 *  These are GLOBAL master data with no `orgId` and no row-level security (see
 *  the Domain/Region model comments), so an org-scoped transaction is the wrong
 *  tool: it would apply a tenant filter to tables that have no tenant column. */
type ReferenceTx = {
  domain: { findMany: (args: unknown) => Promise<Array<{ name: string; nameAr: string | null }>> };
  subDomain: { findMany: (args: unknown) => Promise<Array<{ name: string; nameAr: string | null }>> };
  region: { findMany: (args: unknown) => Promise<Array<{ name: string; nameAr: string | null }>> };
  governorate: { findMany: (args: unknown) => Promise<Array<{ name: string; nameAr: string | null }>> };
  center: { findMany: (args: unknown) => Promise<Array<{ name: string; nameAr: string | null }>> };
};

/**
 * Builds the map for `locale`.
 *
 * English is an empty map rather than an identity one — there is nothing to
 * substitute, and returning empty lets the caller skip the whole pass.
 */
export async function loadReferenceNames(
  tenant: TenantPrismaService,
  locale: AppLocale,
): Promise<ReferenceNameMap> {
  if (locale !== "ar") return {};

  const select = { name: true, nameAr: true };
  // `nameAr: { not: null }` keeps the query result to rows that can actually
  // contribute. On a catalogue where the vocabulary has not arrived yet this
  // returns nothing and the map is empty, which is the correct outcome.
  const where = { nameAr: { not: null } };

  let rows: Array<{ name: string; nameAr: string | null }>;
  try {
    rows = await tenant.runAsSupervisor(async (tx) => {
      const t = tx as unknown as ReferenceTx;
      const [domains, subDomains, regions, governorates, centers] = await Promise.all([
        t.domain.findMany({ select, where }),
        t.subDomain.findMany({ select, where }),
        t.region.findMany({ select, where }),
        t.governorate.findMany({ select, where }),
        t.center.findMany({ select, where }),
      ]);
      return [...domains, ...subDomains, ...regions, ...governorates, ...centers];
    });
  } catch (err) {
    // Fail SOFT, and loudly in the log.
    //
    // This is an enhancement to a report, not a precondition for producing one:
    // without the map, names render in English and the export still lands.
    // Letting it throw made "PDF export" return a 500 the moment the
    // `name_ar` migration had not been deployed yet — the client lost a working
    // feature because a translation lookup failed, which is out of all
    // proportion to what was actually missing.
    //
    // The log is at error level on purpose: an un-deployed migration is a real
    // problem, and it must not become invisible just because the export
    // survives it.
    logger.error(
      `Reference-name lookup failed; Arabic report will render English names. ` +
        `If this says a column does not exist, the name_ar migration has not been deployed. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }

  const map: ReferenceNameMap = {};
  for (const row of rows) {
    const key = row.name.trim();
    // A blank translation is not a translation. Treating "" as present would
    // erase the English name and leave the cell empty, which reads as missing
    // data rather than as a missing translation.
    if (key && row.nameAr && row.nameAr.trim()) map[key] = row.nameAr.trim();
  }
  return map;
}
