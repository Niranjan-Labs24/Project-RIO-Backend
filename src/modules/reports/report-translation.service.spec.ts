import { describe, expect, it } from "vitest";
import { ReportTranslationService } from "./report-translation.service";
import { collectDocStrings, mapDocStrings } from "./doc-strings";
import type { ReportDoc } from "./report-doc";

const doc: ReportDoc = {
  title: "Regional Needs Report — Zaina foundation",
  headerBand: [{ label: "المنطقة", value: "Tabuk" }],
  sections: [
    {
      kind: "note",
      heading: "المنهجية",
      // The single largest block of English left in an Arabic report: prose the
      // chrome dictionary is designed never to touch.
      text: "Severity per governorate is the cross-village mean of its scored villages.",
    },
    {
      kind: "table",
      heading: "التفاصيل",
      columns: ["المحافظة", "الشدة"],
      rows: [["Al-Wajh", "4.20"]],
    },
    { kind: "list", heading: "التوصيات", items: ["Increase teaching staff in Al-Bada'."] },
    { kind: "stats", heading: "التغطية", tiles: [{ label: "الردود", value: "120", sub: "RPT06" }] },
  ],
  audit: [{ label: "روجع بواسطة", value: "amiras" }],
  locale: "ar",
  rtl: true,
};

/** A model that answers every item with a marker, so a test can tell exactly
 *  which strings were sent without asserting on Arabic wording. */
function stubAi(answer: (text: string) => string, seen?: string[][]) {
  return {
    run: async (_task: unknown, prompt: string) => {
      const payload = JSON.parse(prompt.slice(prompt.indexOf("{"))) as {
        items: Array<{ id: string; text: string }>;
      };
      seen?.push(payload.items.map((i) => i.text));
      return {
        response: { items: payload.items.map((i) => ({ id: i.id, ar: answer(i.text) })) },
        raw: null,
      };
    },
  };
}

/** An empty cache that records what was written. */
function stubTenant(writes: Array<Record<string, unknown>> = [], rows: unknown[] = []) {
  const tx = {
    reportTranslation: {
      findMany: async () => rows,
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        writes.push(...args.data);
      },
      updateMany: async () => ({ count: 0 }),
    },
  };
  return {
    runAsSupervisor: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    runAsSupervisorWrite: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };
}

function makeService(ai: unknown, tenant: unknown) {
  return new ReportTranslationService(ai as never, tenant as never);
}

describe("ReportTranslationService", () => {
  it("is a no-op for English, without touching the model or the database", async () => {
    const service = makeService(
      { run: async () => { throw new Error("must not be called"); } },
      { runAsSupervisor: () => { throw new Error("must not be called"); } },
    );
    await expect(service.translateDoc(doc, "en")).resolves.toBe(doc);
  });

  it("sends the prose, list items and place names the dictionaries cannot reach", async () => {
    const seen: string[][] = [];
    const service = makeService(stubAi(() => "مترجم", seen), stubTenant());
    await service.translateDoc(doc, "ar");

    const sent = seen.flat();
    expect(sent).toContain("Severity per governorate is the cross-village mean of its scored villages.");
    expect(sent).toContain("Increase teaching staff in Al-Bada'.");
    expect(sent).toContain("Tabuk");
    expect(sent).toContain("Al-Wajh");
  });

  it("never sends text that is already Arabic, a bare figure, or a report code", async () => {
    const seen: string[][] = [];
    const service = makeService(stubAi(() => "مترجم", seen), stubTenant());
    await service.translateDoc(doc, "ar");

    const sent = seen.flat();
    for (const skipped of ["المنهجية", "المحافظة", "4.20", "120", "RPT06"]) {
      expect(sent).not.toContain(skipped);
    }
  });

  it("never sends a person's name, even though the prompt also forbids translating one", async () => {
    // An audit trail that names an Arabicised spelling of the approver no
    // longer names a real person, so this is enforced rather than requested.
    const seen: string[][] = [];
    const service = makeService(stubAi(() => "مترجم", seen), stubTenant());
    await service.translateDoc(doc, "ar", ["amiras"]);

    expect(seen.flat()).not.toContain("amiras");
  });

  it("splices the answers back into every position they came from", async () => {
    const service = makeService(stubAi((t) => (t === "Tabuk" ? "تبوك" : "مترجم")), stubTenant());
    const out = await service.translateDoc(doc, "ar");

    expect(out.headerBand[0]?.value).toBe("تبوك");
    // And the original is not mutated — the English edition is built from the
    // same document object on the very next request.
    expect(doc.headerBand[0]?.value).toBe("Tabuk");
  });

  it("rejects a translation that changed a figure, and keeps the English", async () => {
    // The one guarantee the export-time design exists for: both editions of one
    // approved report carry identical figures. Nothing downstream re-derives a
    // rendered number, so a silent rounding here would never be caught again.
    const writes: Array<Record<string, unknown>> = [];
    const service = makeService(
      stubAi((t) => (t === "Al-Wajh" ? "الوجه" : "الشدة ٤٫٢ من ٥ خلال 99 قرية")),
      stubTenant(writes),
    );
    const out = await service.translateDoc(doc, "ar");

    const note = out.sections[0];
    expect(note?.kind === "note" && note.text).toBe(
      "Severity per governorate is the cross-village mean of its scored villages.",
    );
    // And the bad answer is not cached, or it would be served forever.
    expect(writes.map((w) => w.translatedText)).not.toContain("الشدة ٤٫٢ من ٥ خلال 99 قرية");
  });

  it("rejects a translation that invented an English word", async () => {
    // "Estimated" appears nowhere in the source, so it is the model writing
    // English rather than copying an identifier it was told to preserve.
    const service = makeService(stubAi(() => "الشدة Estimated"), stubTenant());
    const out = await service.translateDoc(doc, "ar");

    const note = out.sections[0];
    expect(note?.kind === "note" && note.text).toContain("Severity per governorate");
  });

  it("allows Latin that was already in the source, so identifiers survive verbatim", async () => {
    const withCode: ReportDoc = {
      ...doc,
      sections: [{ kind: "note", heading: "المنهجية", text: "Baseline v1.0 approved." }],
    };
    const service = makeService(stubAi(() => "خط الأساس v1.0 معتمد."), stubTenant());
    const out = await service.translateDoc(withCode, "ar");

    const note = out.sections[0];
    expect(note?.kind === "note" && note.text).toBe("خط الأساس v1.0 معتمد.");
  });

  it("caches an accepted translation so a second export costs nothing", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const service = makeService(stubAi(() => "تبوك"), stubTenant(writes));
    await service.translateDoc(doc, "ar");

    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]).toMatchObject({ locale: "ar", source: "ai" });
    // The full source text is stored, not just its hash — the table has to be
    // reviewable by whoever owns the terminology.
    expect(writes[0]?.sourceText).toBeTypeOf("string");
  });

  it("serves a cached row without calling the model at all", async () => {
    const { createHash } = await import("node:crypto");
    const hash = (t: string) => createHash("sha256").update(t).digest("hex");
    const cached = collectDocStrings(doc)
      .filter((s) => /[A-Za-z]{2}/.test(s))
      .map((s) => ({ sourceHash: hash(s), translatedText: "مخزّن" }));

    const service = makeService(
      { run: async () => { throw new Error("must not be called"); } },
      stubTenant([], cached),
    );
    const out = await service.translateDoc(doc, "ar");
    expect(out.headerBand[0]?.value).toBe("مخزّن");
  });

  it("returns the document unchanged when the model fails, so the export still lands", async () => {
    const service = makeService(
      { run: async () => { throw new Error("AI_RATE_LIMITED"); } },
      stubTenant(),
    );
    const out = await service.translateDoc(doc, "ar");
    expect(out.headerBand[0]?.value).toBe("Tabuk");
  });
});

describe("doc-strings", () => {
  it("visits the list items and note prose that localise-doc deliberately skips", () => {
    const all = collectDocStrings(doc);
    expect(all).toContain("Severity per governorate is the cross-village mean of its scored villages.");
    expect(all).toContain("Increase teaching staff in Al-Bada'.");
  });

  it("never visits an anchor id or link target, which would break navigation", () => {
    const linked: ReportDoc = {
      ...doc,
      sections: [
        { kind: "anchor", id: "domain-EDU" },
        { kind: "pageBreak", anchorId: "page-2", heading: "التفاصيل" },
        { kind: "navGrid", heading: "الفهرس", tiles: [{ label: "التعليم", sub: "9 needs", to: "domain-EDU" }] },
      ],
    };
    const out = mapDocStrings(linked, () => "REWRITTEN");
    const anchor = out.sections[0];
    const brk = out.sections[1];
    const grid = out.sections[2];
    expect(anchor?.kind === "anchor" && anchor.id).toBe("domain-EDU");
    expect(brk?.kind === "pageBreak" && brk.anchorId).toBe("page-2");
    expect(grid?.kind === "navGrid" && grid.tiles[0]?.to).toBe("domain-EDU");
    // …while the tile's own visible text IS visited.
    expect(grid?.kind === "navGrid" && grid.tiles[0]?.sub).toBe("REWRITTEN");
  });

  it("returns each distinct string once, in first-seen order", () => {
    const repeated: ReportDoc = {
      ...doc,
      sections: [
        { kind: "table", heading: "أ", columns: ["Severity", "Band"], rows: [["Severity", "HIGH"]] },
      ],
    };
    const all = collectDocStrings(repeated);
    expect(all.filter((s) => s === "Severity")).toHaveLength(1);
  });
});
