import { Injectable, NotFoundException } from "@nestjs/common";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { PublicDocumentReaderService } from "./public-document-reader.service";
import type {
  PublicArchiveDetail,
  PublicArchiveEntry,
  PublicArchiveKind,
  PublicArchiveLabel,
  PublicArchiveResponse,
  PublicDocumentResponse,
} from "./public-archive.types";

/** The only report state a stranger may know exists. `draft` and `submitted`
 *  are someone's unfinished work, `rejected` was turned down, and `archived`
 *  was withdrawn — none of them belong on a public page. */
const PUBLIC_REPORT_STATUSES = ["released"] as const;

/** The year filter runs from the current year back to this one, whether or
 *  not every year in between has an entry. A public record is read as a
 *  timeline, and a year that is present but empty says something the absence
 *  of the option cannot. */
const EARLIEST_FILTER_YEAR = 2015;

/** Ids reach this service straight from a URL that anyone can type. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * RIO-DATA-002 — the read-only public view of the archive.
 *
 * ── WHY IT DOES NOT REUSE ArchiveService ────────────────────────────────────
 * ArchiveService answers "what is in MY archive", scoped by the caller's role
 * and org. This answers a different question — "what work has been recorded,
 * Kingdom-wide" — for a caller who has no role and no org at all. Sharing the
 * method would mean one code path serving both an authenticated operator and
 * the open internet, and the next field added for the operator would reach the
 * internet with it. They are kept apart on purpose.
 *
 * ── HOW IT READS ANYTHING AT ALL ────────────────────────────────────────────
 * Every table enforces row-level security and a public request carries no
 * `app.current_org_id`, so an ordinary query would match no policy and return
 * nothing. `runAsSupervisor` is the same cross-org read the Center Supervisor
 * and System Admin already use, and it is the ONLY thing this service is
 * allowed to do: there is no write path anywhere in this file.
 *
 * ── WHAT IS PUBLISHED, AND ON WHOSE DECISION ────────────────────────────────
 * Settled with the client on 2026-09-23, in that order:
 *
 *  1. They asked for the record itself rather than a summary of it, and were
 *     shown what that meant here — 404 need statements averaging ~960
 *     characters of free text, village names throughout, and only 13 of those
 *     needs approved by a reviewer. They confirmed, with one limit: it opens,
 *     it does not download.
 *  2. Then: released reports and archived prior studies only. Live studies
 *     are work in progress and are not published at all.
 *  3. Then, on seeing an archived study: the document, and nothing else.
 *     "only docs we need."
 *
 * So what goes out today is a report's own stored body, an archived study's
 * uploaded document as rows and text, and the labels that identify an entry —
 * organisation, place, subject area, date. Needs do not appear anywhere in
 * any response: no statement, no village, no count. `list()` reads them for
 * one purpose only, to derive an entry's subject areas, and nothing about
 * them survives into the output.
 *
 * What is never returned, because the limit is the client's and the mechanism
 * is ours to keep:
 *   • storage keys, file hashes or any signed URL — nothing addressable
 *   • uploader, reviewer and approver user ids
 *   • evidence files and contacts
 * There is no route in this module that streams bytes, so "opens but does not
 * download" holds at the API and not merely in the page.
 */
@Injectable()
export class PublicArchiveService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly documents: PublicDocumentReaderService,
  ) {}

  async list(): Promise<PublicArchiveResponse> {
    const {
      organisations,
      studies,
      studyGovernorates,
      reports,
      needs,
      historical,
      governorates,
      regions,
      sectorOptions,
      domains,
    } = await this.tenant.runAsSupervisor(async (tx) => ({
      organisations: await tx.organisation.findMany({
        select: { id: true, name: true },
      }),
      studies: await tx.study.findMany({
        select: {
          id: true,
          title: true,
          orgId: true,
          createdAt: true,
          targetSector: true,
          isHistorical: true,
          historicalStudyDate: true,
          historicalStudyId: true,
        },
      }),
      // Where a study took place. Without this the region filter offers the
      // whole Kingdom and matches nothing, which reads as "no work done here".
      studyGovernorates: await tx.studyGovernorate.findMany({
        select: { studyId: true, governorateId: true },
      }),
      reports: await tx.report.findMany({
        where: { status: { in: [...PUBLIC_REPORT_STATUSES] } },
        select: { id: true, title: true, orgId: true, studyId: true, generatedAt: true },
      }),
      // Read for one reason only: an entry's subject areas are derived from
      // how its needs were classified. Nothing about a need reaches the
      // response — no count, no title, no statement. A `findMany()` with no
      // select would pull statements and contacts into memory on a route
      // anyone can call.
      needs: await tx.need.findMany({
        select: { studyId: true, mergedIntoNeedId: true, domain: true },
      }),
      historical: await tx.historicalStudy.findMany({
        select: {
          id: true,
          title: true,
          orgId: true,
          targetSector: true,
          studyDate: true,
          governorateIds: true,
        },
      }),
      governorates: await tx.governorate.findMany({
        select: {
          id: true,
          name: true,
          nameAr: true,
          region: { select: { name: true, nameAr: true } },
        },
      }),
      // Master data, not a projection of the entries — see PublicArchiveFilters.
      regions: await tx.region.findMany({
        select: { name: true, nameAr: true },
        orderBy: { code: "asc" },
      }),
      sectorOptions: await tx.targetSectorOption.findMany({
        where: { isActive: true },
        select: { name: true, nameAr: true },
        orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
      }),
      domains: await tx.domain.findMany({
        where: { isActive: true },
        select: { name: true, nameAr: true },
        orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
      }),
    }));

    const orgName = new Map(organisations.map((o) => [o.id, o.name]));
    const govById = new Map(governorates.map((g) => [g.id, g]));
    const sectorByName = new Map(sectorOptions.map((s) => [s.name, s]));

    const domainByName = new Map(domains.map((d) => [d.name, d]));

    const domainNamesByStudy = new Map<string, Set<string>>();
    for (const need of needs) {
      // A merged need is the same need recorded twice, and its classification
      // is already counted under the need it was merged into.
      if (need.mergedIntoNeedId || !need.domain) continue;
      const set = domainNamesByStudy.get(need.studyId) ?? new Set<string>();
      set.add(need.domain);
      domainNamesByStudy.set(need.studyId, set);
    }

    /** `Need.domain` is the domain's name copied onto the need, so a domain
     *  renamed in master data leaves older needs pointing at a name that no
     *  longer resolves. Those are still shown, just without Arabic, rather
     *  than dropped — the classification happened. */
    const domainsOfStudy = (studyId: string | null): PublicArchiveLabel[] =>
      [...(studyId ? (domainNamesByStudy.get(studyId) ?? new Set<string>()) : new Set<string>())]
        .sort()
        .map((name) => {
          const known = domainByName.get(name);
          return known ? { name: known.name, nameAr: known.nameAr } : { name, nameAr: null };
        });

    // An upload and the Study its import created are the same archived study,
    // and only the upload is published — so the upload inherits what the
    // import produced: where the work happened, and what it was about.
    const studyByHistoricalId = new Map<string, string>();
    for (const study of studies) {
      if (study.historicalStudyId) studyByHistoricalId.set(study.historicalStudyId, study.id);
    }

    const govIdsByStudy = new Map<string, string[]>();
    for (const link of studyGovernorates) {
      const list = govIdsByStudy.get(link.studyId) ?? [];
      list.push(link.governorateId);
      govIdsByStudy.set(link.studyId, list);
    }

    /** Governorate ids to the place labels shown on the page, deduplicated
     *  and with their parent regions rolled up. */
    const placesOf = (ids: readonly string[]) => {
      const govs = ids
        .map((id) => govById.get(id))
        .filter((g): g is NonNullable<typeof g> => g != null);
      const seenRegion = new Set<string>();
      const regionLabels: PublicArchiveLabel[] = [];
      for (const g of govs) {
        if (!g.region || seenRegion.has(g.region.name)) continue;
        seenRegion.add(g.region.name);
        regionLabels.push({ name: g.region.name, nameAr: g.region.nameAr });
      }
      return {
        regions: regionLabels,
        governorates: govs.map((g) => ({ name: g.name, nameAr: g.nameAr })),
      };
    };

    const sectorOf = (name: string | null): PublicArchiveLabel | null => {
      if (!name) return null;
      const known = sectorByName.get(name);
      // A study may carry a sector that has since been deactivated in master
      // data. It still happened, so it is still shown, just without Arabic.
      return known ? { name: known.name, nameAr: known.nameAr } : { name, nameAr: null };
    };

    const entries: PublicArchiveEntry[] = [];

    for (const study of studies) {
      // Live studies are still read above — a report borrows its study's
      // geography — but they are not published themselves. See
      // PublicArchiveKind for why.
      if (!study.isHistorical) continue;

      // Importing a prior study creates a Study row beside the upload it came
      // from, so both describe the same archived study. Listing both showed
      // it twice: once with its document and once without, the second looking
      // like a broken entry. The upload is the one published, because it is
      // the one that has the document — this is the copy that is skipped.
      if (study.historicalStudyId !== null) continue;
      entries.push({
        id: study.id,
        kind: "historical",
        title: study.title,
        date: (study.historicalStudyDate ?? study.createdAt).toISOString(),
        organizationName: orgName.get(study.orgId) ?? "",
        ...placesOf(govIdsByStudy.get(study.id) ?? []),
        sector: sectorOf(study.targetSector),
        domains: domainsOfStudy(study.id),
      });
    }

    for (const report of reports) {
      // A report has no geography of its own, so it inherits the study's.
      const studyGovIds = report.studyId ? (govIdsByStudy.get(report.studyId) ?? []) : [];
      entries.push({
        id: report.id,
        kind: "report",
        title: report.title,
        date: report.generatedAt.toISOString(),
        organizationName: orgName.get(report.orgId) ?? "",
        ...placesOf(studyGovIds),
        sector: null,
        domains: domainsOfStudy(report.studyId),
      });
    }

    for (const h of historical) {
      const importedStudyId = studyByHistoricalId.get(h.id);
      // The upload records its own governorates; where the import produced a
      // Study, that Study's geography is the fuller answer.
      const govIds =
        importedStudyId && (govIdsByStudy.get(importedStudyId)?.length ?? 0) > 0
          ? (govIdsByStudy.get(importedStudyId) ?? [])
          : (h.governorateIds ?? []);
      entries.push({
        id: h.id,
        kind: "historical",
        title: h.title,
        date: (h.studyDate ?? new Date()).toISOString(),
        organizationName: orgName.get(h.orgId) ?? "",
        ...placesOf(govIds),
        sector: sectorOf(h.targetSector),
        // An upload holds no Needs itself; its subject areas are whatever the
        // import classified. An upload that was never imported has none.
        domains: domainsOfStudy(importedStudyId ?? null),
      });
    }

    entries.sort((a, b) => b.date.localeCompare(a.date));

    const dates = entries.map((e) => e.date).sort();
    const thisYear = new Date().getFullYear();
    const years: string[] = [];
    for (let y = thisYear; y >= EARLIEST_FILTER_YEAR; y--) years.push(String(y));

    return {
      summary: {
        reports: entries.filter((e) => e.kind === "report").length,
        historical: entries.filter((e) => e.kind === "historical").length,
        organisations: new Set(entries.map((e) => e.organizationName).filter(Boolean)).size,
        earliest: dates[0] ?? null,
        latest: dates[dates.length - 1] ?? null,
      },
      entries,
      available: {
        domains: domains.map((d) => ({ name: d.name, nameAr: d.nameAr })),
        regions: regions.map((r) => ({ name: r.name, nameAr: r.nameAr })),
        years,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * One entry, opened.
   *
   * The client asked on 2026-09-23 for the record itself to be readable
   * without signing in — not a summary of it — having been shown first that
   * this publishes need statements (free text that names villages and
   * households), village names, and needs that no reviewer has approved.
   * They confirmed, and added one limit: it opens, it does not download.
   *
   * That limit is kept at the API, not in the UI. Nothing below returns a
   * storage key, a file hash or a signed URL, and there is no route in this
   * module that streams bytes — so there is nothing for a reader to call
   * even with the ids in front of them.
   */
  async detail(kind: PublicArchiveKind, id: string): Promise<PublicArchiveDetail> {
    // An id that cannot be a uuid is rejected before it reaches Prisma, so a
    // malformed public request is a 404 rather than a 500 with a driver
    // message in it.
    if (!UUID_PATTERN.test(id)) throw new NotFoundException("Entry not found");

    return this.tenant.runAsSupervisor(async (tx) => {
      const [governorates, sectorOptions] = await Promise.all([
        tx.governorate.findMany({
          select: {
            id: true,
            name: true,
            nameAr: true,
            region: { select: { name: true, nameAr: true } },
          },
        }),
        tx.targetSectorOption.findMany({
          where: { isActive: true },
          select: { name: true, nameAr: true },
        }),
      ]);
      const govById = new Map(governorates.map((g) => [g.id, g]));
      const sectorByName = new Map(sectorOptions.map((s) => [s.name, s]));

      const placesOf = (ids: readonly string[]) => {
        const govs = ids
          .map((gid) => govById.get(gid))
          .filter((g): g is NonNullable<typeof g> => g != null);
        const seen = new Set<string>();
        const regionLabels: PublicArchiveLabel[] = [];
        for (const g of govs) {
          if (!g.region || seen.has(g.region.name)) continue;
          seen.add(g.region.name);
          regionLabels.push({ name: g.region.name, nameAr: g.region.nameAr });
        }
        return {
          regions: regionLabels,
          governorates: govs.map((g) => ({ name: g.name, nameAr: g.nameAr })),
        };
      };

      const sectorOf = (name: string | null): PublicArchiveLabel | null => {
        if (!name) return null;
        const known = sectorByName.get(name);
        return known ? { name: known.name, nameAr: known.nameAr } : { name, nameAr: null };
      };

      const orgNameOf = async (orgId: string) =>
        (await tx.organisation.findUnique({ where: { id: orgId }, select: { name: true } }))?.name ??
        "";

      const govIdsOfStudy = async (studyId: string) =>
        (
          await tx.studyGovernorate.findMany({
            where: { studyId },
            select: { governorateId: true },
          })
        ).map((l) => l.governorateId);

      if (kind === "report") {
        const report = await tx.report.findFirst({
          // The status filter is part of the lookup, not a check after it: a
          // draft report is not "found and refused", it is not found at all,
          // so a reader cannot learn that an unreleased report exists by the
          // shape of the error.
          where: { id, status: { in: [...PUBLIC_REPORT_STATUSES] } },
          select: {
            id: true,
            title: true,
            orgId: true,
            studyId: true,
            generatedAt: true,
            reportType: true,
            content: true,
          },
        });
        if (!report) throw new NotFoundException("Entry not found");

        const govIds = report.studyId ? await govIdsOfStudy(report.studyId) : [];

        return {
          id: report.id,
          kind: "report" as const,
          title: report.title,
          date: report.generatedAt.toISOString(),
          organizationName: await orgNameOf(report.orgId),
          ...placesOf(govIds),
          sector: null,
          report: { reportType: String(report.reportType), content: report.content },
          historical: null,
        };
      }

      // `historical` covers two different records: a Study flagged
      // isHistorical, and a HistoricalStudy upload. They are separate tables
      // with separate ids, so both are tried before giving up.
      const study = await tx.study.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          orgId: true,
          createdAt: true,
          targetSector: true,
          isHistorical: true,
          historicalStudyDate: true,
          historicalStudyId: true,
        },
      });

      // A live study is not part of the public record, and neither is the
      // Study copy of an imported prior study — the upload it came from is
      // published instead. Both resolve to nothing rather than to a page that
      // hides its contents: guessing an id must not confirm one exists.
      if (study && (!study.isHistorical || study.historicalStudyId !== null)) {
        throw new NotFoundException("Entry not found");
      }

      if (study) {
        // No needs, no cycle, no sample size. The client asked on 2026-09-23
        // for these entries to show the document and nothing else — the needs
        // an import produced are the platform's own working records, not part
        // of what a reader came here to read.
        //
        // A Study flagged historical carries no uploaded file of its own
        // (only HistoricalStudy has a storage key), so it reports no
        // document and the page says so rather than showing an empty viewer.
        return {
          id: study.id,
          kind: "historical" as const,
          title: study.title,
          date: (study.historicalStudyDate ?? study.createdAt).toISOString(),
          organizationName: await orgNameOf(study.orgId),
          ...placesOf(await govIdsOfStudy(study.id)),
          sector: sectorOf(study.targetSector),
          report: null,
          historical: {
            author: null,
            methodologyVersionLabel: null,
            fileName: null,
            fileType: null,
            fileSize: null,
            hasDocument: false,
          },
        };
      }

      const h = await tx.historicalStudy.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          orgId: true,
          targetSector: true,
          studyDate: true,
          governorateIds: true,
          author: true,
          methodologyVersionLabel: true,
          fileName: true,
          fileType: true,
          fileSize: true,
          // Read to answer "is there a document", never placed in the
          // response — see the class note on what is deliberately withheld.
          storageKey: true,
        },
      });
      if (!h) throw new NotFoundException("Entry not found");

      return {
        id: h.id,
        kind: "historical" as const,
        title: h.title,
        date: (h.studyDate ?? new Date()).toISOString(),
        organizationName: await orgNameOf(h.orgId),
        ...placesOf(h.governorateIds ?? []),
        sector: sectorOf(h.targetSector),
        report: null,
        historical: {
          author: h.author,
          methodologyVersionLabel: h.methodologyVersionLabel,
          fileName: h.fileName,
          fileType: h.fileType,
          fileSize: h.fileSize,
          // Says whether the "open document" view has anything to open, so
          // the page can leave the section out rather than offering a button
          // that resolves to "unavailable".
          hasDocument: Boolean(h.storageKey),
        },
      };
    });
  }

  /**
   * The uploaded document behind a historical study, as page content.
   *
   * Separate from `detail()` because parsing a file is the expensive part and
   * most readers of an entry never open it. Returns rows and text — never
   * bytes, never a storage key, never a url. See PublicDocumentReaderService
   * for why that distinction is the entire feature.
   */
  async document(id: string): Promise<PublicDocumentResponse> {
    if (!UUID_PATTERN.test(id)) throw new NotFoundException("Document not found");

    const record = await this.tenant.runAsSupervisor((tx) =>
      tx.historicalStudy.findUnique({
        where: { id },
        select: { storageKey: true, fileName: true, fileType: true, fileSize: true },
      }),
    );
    if (!record?.storageKey) throw new NotFoundException("Document not found");

    return {
      fileName: record.fileName,
      fileType: record.fileType,
      fileSize: record.fileSize,
      view: await this.documents.read(record.storageKey, record.fileName),
    };
  }
}
