import { describe, expect, it } from "vitest";
import { loadReferenceNames } from "./reference-names";
import { localiseReportDoc } from "./localise-doc";
import type { ReportDoc } from "./report-doc";
import type { TenantPrismaService } from "../../tenancy/tenant-prisma.service";

/** A TenantPrismaService stand-in whose supervisor transaction serves fixed
 *  catalogue rows. Only `runAsSupervisor` is reached by this module. */
function fakeTenant(rows: {
  domain?: Array<{ name: string; nameAr: string | null }>;
  subDomain?: Array<{ name: string; nameAr: string | null }>;
  region?: Array<{ name: string; nameAr: string | null }>;
  governorate?: Array<{ name: string; nameAr: string | null }>;
  center?: Array<{ name: string; nameAr: string | null }>;
}): TenantPrismaService {
  const table = (list: Array<{ name: string; nameAr: string | null }> = []) => ({
    findMany: async () => list.filter((r) => r.nameAr !== null),
  });
  const tx = {
    domain: table(rows.domain),
    subDomain: table(rows.subDomain),
    region: table(rows.region),
    governorate: table(rows.governorate),
    center: table(rows.center),
  };
  return {
    runAsSupervisor: async <T>(fn: (t: unknown) => Promise<T>) => fn(tx),
  } as unknown as TenantPrismaService;
}

describe("loadReferenceNames", () => {
  it("returns nothing for English — there is nothing to substitute", async () => {
    const tenant = fakeTenant({ domain: [{ name: "Education", nameAr: "التعليم" }] });
    expect(await loadReferenceNames(tenant, "en")).toEqual({});
  });

  it("maps every catalogue that carries a name", async () => {
    const tenant = fakeTenant({
      domain: [{ name: "Education", nameAr: "التعليم" }],
      subDomain: [{ name: "Access", nameAr: "الوصول" }],
      region: [{ name: "Tabuk", nameAr: "تبوك" }],
      governorate: [{ name: "Al-Wajh", nameAr: "الوجه" }],
      center: [{ name: "Al-Bada'", nameAr: "البدع" }],
    });
    expect(await loadReferenceNames(tenant, "ar")).toEqual({
      Education: "التعليم",
      Access: "الوصول",
      Tabuk: "تبوك",
      "Al-Wajh": "الوجه",
      "Al-Bada'": "البدع",
    });
  });

  it("ignores a blank translation rather than erasing the English name", async () => {
    // "" would substitute an empty cell, which reads as MISSING DATA — a much
    // worse failure than an untranslated name.
    const tenant = fakeTenant({
      domain: [
        { name: "Education", nameAr: "   " },
        { name: "Health", nameAr: "الصحة" },
      ],
    });
    expect(await loadReferenceNames(tenant, "ar")).toEqual({ Health: "الصحة" });
  });

  it("is empty when the vocabulary has not been supplied yet", async () => {
    // The expected state on day one. An empty map means every name renders in
    // English — visibly incomplete, never silently wrong.
    const tenant = fakeTenant({ domain: [{ name: "Education", nameAr: null }] });
    expect(await loadReferenceNames(tenant, "ar")).toEqual({});
  });
});

describe("localiseReportDoc with reference names", () => {
  const doc: ReportDoc = {
    title: "Village Report — Al-Wajh",
    headerBand: [{ label: "Domain", value: "Education" }],
    sections: [
      {
        kind: "table",
        heading: "Domains",
        columns: ["Domain", "Governorate"],
        rows: [["Education", "Al-Wajh"]],
      },
      {
        kind: "bars",
        heading: "Domain Severity (0-100)",
        max: 100,
        bars: [{ label: "Education", value: 33 }],
      },
      { kind: "list", heading: "Recommendations", items: ["Prioritise Education."] },
    ],
    audit: [],
  };
  const names = { Education: "التعليم", "Al-Wajh": "الوجه" };

  it("translates reference names in table cells and chart labels", () => {
    // Chart point labels are precisely where domain and governorate names show
    // up, and they were the last English left in an otherwise-Arabic chart.
    const out = localiseReportDoc(doc, "ar", names);
    expect((out.sections[0] as { rows: string[][] }).rows[0]).toEqual(["التعليم", "الوجه"]);
    expect((out.sections[1] as { bars: Array<{ label: string }> }).bars[0]!.label).toBe("التعليم");
    expect(out.headerBand[0]!.value).toBe("التعليم");
  });

  it("keeps our column header and their data distinct", () => {
    // "Domain" as a COLUMN HEADER is our chrome; "Education" in a CELL is their
    // data. The two live in different positions and must not be confused.
    const out = localiseReportDoc(doc, "ar", names);
    expect((out.sections[0] as { columns: string[] }).columns[0]).toBe("المجال");
  });

  it("leaves narrative prose alone even when it names a domain", () => {
    // Substituting inside a sentence would produce half-translated prose. The
    // narrative's language is the model's job, not a lookup table's.
    const out = localiseReportDoc(doc, "ar", names);
    expect((out.sections[2] as { items: string[] }).items).toEqual(["Prioritise Education."]);
  });

  it("falls back to English for a name with no translation yet", () => {
    const out = localiseReportDoc(doc, "ar", { Education: "التعليم" });
    expect((out.sections[0] as { rows: string[][] }).rows[0]).toEqual(["التعليم", "Al-Wajh"]);
  });

  it("still translates chrome when no reference names are supplied", () => {
    const out = localiseReportDoc(doc, "ar", {});
    expect((out.sections[0] as { columns: string[] }).columns[0]).toBe("المجال");
    expect((out.sections[0] as { rows: string[][] }).rows[0]).toEqual(["Education", "Al-Wajh"]);
  });
});
