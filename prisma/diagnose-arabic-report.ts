/**
 * diagnose-arabic-report.ts
 *
 * Answers one question, against the real database and the real API key:
 * WHY does an Arabic export still contain English?
 *
 * WHY THIS EXISTS
 *
 * Every layer of the Arabic pipeline fails soft, deliberately: a missing
 * `GEMINI_API_KEY`, an undeployed migration, a rate limit and a rejected
 * translation all degrade to English rather than to a failed download. That is
 * the right trade — a reader losing their report is worse than a reader getting
 * an imperfect one — but it means the difference between "the pass ran and did
 * its job" and "the pass never ran at all" looks IDENTICAL in the PDF. Three
 * Arabic exports in a row came back with English in them and the file itself
 * could not say which layer was responsible.
 *
 * So this runs the exact export pipeline — the same `buildReportDoc`, the same
 * dictionaries, the same `ReportTranslationService` — on a report already in
 * the database, and reports each layer's result separately.
 *
 *   pnpm diag:arabic              # newest exportable report
 *   pnpm diag:arabic <reportId>   # a specific one
 *
 * It is READ-ONLY with respect to reports. It will populate the translation
 * cache, exactly as a real export would.
 */
import { PrismaClient } from "../src/generated/prisma";
import { buildReportDoc } from "../src/modules/reports/report-doc";
import { localiseReportDoc } from "../src/modules/reports/localise-doc";
import { collectDocStrings } from "../src/modules/reports/doc-strings";
import {
  ReportTranslationService,
  unexplainedLatin,
} from "../src/modules/reports/report-translation.service";
import { REPORT_TRANSLATION_TASK } from "../src/modules/ai/prompts/report-translation.task";
import type { ReportDoc } from "../src/modules/reports/report-doc";

const prisma = new PrismaClient();

const ok = (s: string) => `  \x1b[32m✓\x1b[0m ${s}`;
const bad = (s: string) => `  \x1b[31m✗\x1b[0m ${s}`;
const info = (s: string) => `    ${s}`;

/** The real AI transport, minus Nest. `AiService` needs a `ConfigService`, and
 *  standing up the DI container to read one environment variable would make
 *  this script fail for reasons that have nothing to do with translation. */
async function callGemini(prompt: string): Promise<{ items: Array<{ id: string; ar: string }> }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${REPORT_TRANSLATION_TASK.model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: REPORT_TRANSLATION_TASK.systemPrompt }] },
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: REPORT_TRANSLATION_TASK.responseSchema,
        temperature: REPORT_TRANSLATION_TASK.temperature,
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text part");
  return JSON.parse(text) as { items: Array<{ id: string; ar: string }> };
}

async function main() {
  const reportId = process.argv[2];

  console.log("\n\x1b[1mArabic export diagnosis\x1b[0m\n");

  // ── 1. Is the key configured at all? ────────────────────────────────────
  console.log("\x1b[1m1. Gemini API key\x1b[0m");
  const hasKey = Boolean(process.env.GEMINI_API_KEY);
  console.log(
    hasKey
      ? ok(`GEMINI_API_KEY is set (${process.env.GEMINI_API_KEY!.length} chars)`)
      : bad("GEMINI_API_KEY is NOT set — the translation pass cannot run, and every"),
  );
  if (!hasKey) {
    console.log(info("Arabic export will keep its English. Set it on the API process,"));
    console.log(info("not just in your shell, and restart the API."));
  }

  // ── 2. Is the cache table deployed? ─────────────────────────────────────
  console.log("\n\x1b[1m2. Translation cache table\x1b[0m");
  let cacheReadable = false;
  let cachedRows = 0;
  try {
    cachedRows = await prisma.reportTranslation.count({ where: { locale: "ar" } });
    cacheReadable = true;
    console.log(ok(`report_translations is readable — ${cachedRows} Arabic row(s) cached`));
  } catch (err) {
    console.log(bad(`report_translations is NOT readable: ${(err as Error).message.split("\n")[0]}`));
    console.log(info("Run `pnpm prisma:deploy`. The pass still works without it, but every"));
    console.log(info("export re-asks the model and two exports can word a finding differently."));
  }

  // ── 3. Are the reference names deployed and populated? ──────────────────
  console.log("\n\x1b[1m3. Reference vocabulary (name_ar)\x1b[0m");
  try {
    const [domains, govs, centres] = await Promise.all([
      prisma.domain.count({ where: { nameAr: { not: null } } }),
      prisma.governorate.count({ where: { nameAr: { not: null } } }),
      prisma.center.count({ where: { nameAr: { not: null } } }),
    ]);
    console.log(ok(`domains with name_ar: ${domains}, governorates: ${govs}, centres: ${centres}`));
    if (domains === 0) console.log(info("Run `pnpm seed:names-ar` — domain names will render in English until you do."));
    if (govs === 0) console.log(info("Governorates have no name_ar; the AI pass translates them instead."));
  } catch (err) {
    console.log(bad(`name_ar columns missing: ${(err as Error).message.split("\n")[0]}`));
    console.log(info("The 20260828140000_reference_name_ar migration has not been deployed."));
  }

  // ── 4. Run the real pipeline on a real report ───────────────────────────
  console.log("\n\x1b[1m4. The export pipeline, on a stored report\x1b[0m");
  const report = reportId
    ? await prisma.report.findUnique({ where: { id: reportId } })
    : await prisma.report.findFirst({
        where: { status: { in: ["released", "archived"] } },
        orderBy: { generatedAt: "desc" },
      });

  if (!report) {
    console.log(bad(reportId ? `No report with id ${reportId}` : "No released report found to test with."));
    return;
  }
  console.log(ok(`${report.reportType} — ${report.title}`));
  console.log(info(`id ${report.id}`));

  const built = buildReportDoc(
    report.title,
    report.content as Record<string, unknown>,
    [],
    "ar",
  );
  const beforeStrings = collectDocStrings({ ...built, locale: "ar", rtl: true } as ReportDoc);

  // Reference names, loaded the way the export loads them.
  const referenceNames: Record<string, string> = {};
  try {
    const rows = await Promise.all([
      prisma.domain.findMany({ select: { name: true, nameAr: true }, where: { nameAr: { not: null } } }),
      prisma.subDomain.findMany({ select: { name: true, nameAr: true }, where: { nameAr: { not: null } } }),
      prisma.region.findMany({ select: { name: true, nameAr: true }, where: { nameAr: { not: null } } }),
      prisma.governorate.findMany({ select: { name: true, nameAr: true }, where: { nameAr: { not: null } } }),
      prisma.center.findMany({ select: { name: true, nameAr: true }, where: { nameAr: { not: null } } }),
    ]);
    for (const row of rows.flat()) if (row.nameAr) referenceNames[row.name.trim()] = row.nameAr.trim();
  } catch {
    /* already reported in step 3 */
  }

  const localised = localiseReportDoc({ ...built, locale: "ar", rtl: true } as ReportDoc, "ar", referenceNames);
  const afterDict = unexplainedLatin(localised);
  console.log(
    info(
      `after dictionaries: ${afterDict.length} of ${beforeStrings.length} strings still hold English`,
    ),
  );

  if (!hasKey) {
    console.log(bad("Skipping the AI pass — no key. The strings below are what it would fix:"));
    for (const s of afterDict.slice(0, 15)) console.log(info(`  "${s.slice(0, 90)}"`));
    return;
  }

  // The real service, wired to the real model and the real cache.
  const ai = {
    run: async (_task: unknown, prompt: string) => ({ response: await callGemini(prompt), raw: null }),
  };
  const tenant = {
    runAsSupervisor: <T>(fn: (tx: typeof prisma) => Promise<T>) => fn(prisma),
    runAsSupervisorWrite: <T>(fn: (tx: typeof prisma) => Promise<T>) => fn(prisma),
  };
  const service = new ReportTranslationService(ai as never, tenant as never);

  console.log(info(`calling ${REPORT_TRANSLATION_TASK.model}…`));
  const started = Date.now();
  const translated = await service.translateDoc(localised, "ar");
  const residue = unexplainedLatin(translated);
  console.log(info(`took ${((Date.now() - started) / 1000).toFixed(1)}s`));

  console.log("\n\x1b[1m5. Result\x1b[0m");
  if (residue.length === 0) {
    console.log(ok("No English left anywhere in the document."));
  } else {
    console.log(bad(`${residue.length} string(s) still hold English:`));
    for (const s of residue.slice(0, 25)) console.log(info(`  "${s.slice(0, 90)}"`));
    if (residue.length > 25) console.log(info(`  …and ${residue.length - 25} more`));
    console.log(info(""));
    console.log(info("A person's or organisation's name here is correct — those are never"));
    console.log(info("translated. Anything else is a real leak: check the API log for"));
    console.log(info('"Rejected translation" lines, which name what the model got wrong.'));
  }

  if (cacheReadable) {
    const after = await prisma.reportTranslation.count({ where: { locale: "ar" } });
    console.log(info(`translation cache: ${cachedRows} → ${after} rows`));
  }
}

main()
  .catch((err) => {
    console.error("\n\x1b[31mDiagnosis failed:\x1b[0m", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
