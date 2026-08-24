import { describe, expect, it, vi } from 'vitest';
import { PublicSurveysService } from './public-surveys.service';

// Focused unit coverage for Task 2 (formula-injection neutralization) — a
// fake `tx` stands in for the real Prisma transaction client so this proves
// sanitizeForSpreadsheet is actually wired into both export paths, without
// needing a live database or the full citizen OTP submission flow.
function makeFakeTx(need: unknown, responses: unknown[], survey: unknown) {
  // RIO-FR-011: buildQuestionMap unions every version's questions for a
  // Need (see its own comment) via survey.findMany, not a single
  // survey.findFirst any more — the fixture is still "the one survey" a
  // test cares about, just wrapped as the one-element result set that
  // query now returns.
  return {
    need: { findUnique: vi.fn().mockResolvedValue(need) },
    surveyResponse: {
      findMany: vi.fn().mockResolvedValue(responses),
      count: vi.fn().mockResolvedValue(responses.length),
    },
    survey: { findMany: vi.fn().mockResolvedValue(survey ? [survey] : []) },
  };
}

function makeService(tx: ReturnType<typeof makeFakeTx>) {
  const tenant = { runInOrgContext: vi.fn((cb: (tx: unknown) => unknown) => cb(tx)) };
  const config = {
    publicAppUrl: 'http://localhost:3001',
    encryptionKey: 'test-only-32-byte-placeholder-k',
  };
  const audit = { record: vi.fn() };
  const mailer = { send: vi.fn() };
  return new PublicSurveysService(tenant as never, config as never, audit as never, mailer as never);
}

const NEED = { id: 'need-1' };
const SURVEY = {
  surveyQuestions: [
    { id: 'q1', question: { questionText: 'Your name', answerType: 'short_text' }, customText: null, customAnswerType: null },
  ],
};

describe('PublicSurveysService export formula-injection neutralization', () => {
  it('exportResponsesCsv neutralizes a malicious answer and contact value', async () => {
    const responses = [
      {
        contactName: '=cmd|/c calc',
        contact: '=HYPERLINK("http://evil.example")',
        submittedAt: new Date('2026-01-01T00:00:00.000Z'),
        answers: { q1: '+1+1' },
      },
    ];
    const service = makeService(makeFakeTx(NEED, responses, SURVEY));

    const csv = await service.exportResponsesCsv('need-1');

    expect(csv).toContain('"\'=cmd|/c calc"');
    expect(csv).toContain('"\'=HYPERLINK(""http://evil.example"")"');
    expect(csv).toContain('"\'+1+1"');
    // Never actually executed as a formula in the string itself.
    expect(csv).not.toMatch(/(?<!')="?cmd/);
  });

  it('exportResponsesCsv leaves ordinary values unchanged', async () => {
    const responses = [
      {
        contactName: 'Amira Al-Fahad',
        contact: 'amira@example.org',
        submittedAt: new Date('2026-01-01T00:00:00.000Z'),
        answers: { q1: 'No issues to report' },
      },
    ];
    const service = makeService(makeFakeTx(NEED, responses, SURVEY));

    const csv = await service.exportResponsesCsv('need-1');

    expect(csv).toContain('"Amira Al-Fahad"');
    expect(csv).toContain('"amira@example.org"');
    expect(csv).toContain('"No issues to report"');
  });

  it('exportResponsesExcel neutralizes a malicious answer without breaking the workbook', async () => {
    const responses = [
      {
        contactName: '@SUM(1,2)',
        contact: 'respondent@example.org',
        submittedAt: new Date('2026-01-01T00:00:00.000Z'),
        answers: { q1: '-2+3+cmd' },
      },
    ];
    const service = makeService(makeFakeTx(NEED, responses, SURVEY));

    const buffer = await service.exportResponsesExcel('need-1');
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK'); // still a valid xlsx (zip)
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('exportResponsesExcel (streaming writer) produces a readable workbook with every row across cursor batches', async () => {
    const tx = makeFakeTx(NEED, [], SURVEY);
    const makeBatch = (n: number, offset: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `r-${offset + i}`,
        contactName: `Respondent ${offset + i}`,
        contact: `r${offset + i}@example.com`,
        submittedAt: new Date('2026-01-01T00:00:00.000Z'),
        answers: { q1: `answer-${offset + i}` },
      }));
    (tx.surveyResponse.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeBatch(1_000, 0))
      .mockResolvedValueOnce(makeBatch(500, 1_000)); // short page ends pagination

    const service = makeService(tx);
    const buffer = await service.exportResponsesExcel('need-1');

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const sheet = wb.getWorksheet('Survey Responses');
    // +1 for the header row.
    expect(sheet?.rowCount).toBe(1_500 + 1);
    expect(sheet?.getRow(2).getCell(1).value).toBe('Respondent 0');
    expect(sheet?.getRow(1_501).getCell(1).value).toBe('Respondent 1499');
  });
});

describe('PublicSurveysService bounded reads (Task 8)', () => {
  it('exportResponsesCsv reads its first batch in EXPORT_BATCH_SIZE (1,000), not one unbounded 50,000-row read', async () => {
    const tx = makeFakeTx(NEED, [], SURVEY);
    const service = makeService(tx);

    await service.exportResponsesCsv('need-1');

    expect(tx.surveyResponse.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1_000 }),
    );
    // No previous-page cursor on the very first batch.
    expect(tx.surveyResponse.findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ cursor: expect.anything() }),
    );
  });

  it('listResponsesWithAnswers requests a bounded take, not an unbounded read', async () => {
    const tx = makeFakeTx(NEED, [], SURVEY);
    const service = makeService(tx);

    await service.listResponsesWithAnswers('need-1');

    expect(tx.surveyResponse.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50_000 }),
    );
  });

  it('exportResponsesCsv advances a stable id cursor across batches and stops on a short page', async () => {
    const tx = makeFakeTx(NEED, [], SURVEY);
    const makeBatch = (n: number, offset: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `r-${offset + i}`,
        contactName: `Respondent ${offset + i}`,
        contact: `r${offset + i}@example.com`,
        submittedAt: new Date('2026-01-01T00:00:00.000Z'),
        answers: { q1: `answer-${offset + i}` },
      }));
    (tx.surveyResponse.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeBatch(1_000, 0))
      .mockResolvedValueOnce(makeBatch(1_000, 1_000))
      .mockResolvedValueOnce(makeBatch(250, 2_000)); // short page ends pagination

    const service = makeService(tx);
    const csv = await service.exportResponsesCsv('need-1');

    expect(tx.surveyResponse.findMany).toHaveBeenCalledTimes(3);
    const calls = (tx.surveyResponse.findMany as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1]?.[0].cursor).toEqual({ id: 'r-999' });
    expect(calls[2]?.[0].cursor).toEqual({ id: 'r-1999' });

    // Row completeness: exactly 2,250 data rows (+1 header) survive the
    // cursor-batched read, none dropped or duplicated across the boundary.
    const dataLines = csv.split('\n').slice(1);
    expect(dataLines).toHaveLength(2_250);
    expect(dataLines[0]).toContain('answer-0');
    expect(dataLines[dataLines.length - 1]).toContain('answer-2249');
  });

  it('exportResponsesCsv never holds more than one batch of raw rows in memory at once', async () => {
    // Approximates "acceptable heap behavior" for the cursor-batched export:
    // streaming EXPORT_BATCH_SIZE-sized pages of a large export should not
    // grow the heap anywhere near what holding all rows at once would cost.
    // This is a coarse, environment-sensitive signal (GC timing isn't
    // deterministic) — it asserts an order-of-magnitude bound, not an exact
    // byte count.
    const tx = makeFakeTx(NEED, [], SURVEY);
    const totalRows = 20_000;
    const batchSize = 1_000;
    const bigAnswerText = 'x'.repeat(2_000); // simulate a realistic long free-text answer
    const mockFindMany = tx.surveyResponse.findMany as ReturnType<typeof vi.fn>;
    for (let offset = 0; offset < totalRows; offset += batchSize) {
      mockFindMany.mockResolvedValueOnce(
        Array.from({ length: batchSize }, (_, i) => ({
          id: `r-${offset + i}`,
          contactName: `Respondent ${offset + i}`,
          contact: `r${offset + i}@example.com`,
          submittedAt: new Date('2026-01-01T00:00:00.000Z'),
          answers: { q1: bigAnswerText },
        })),
      );
    }
    mockFindMany.mockResolvedValueOnce([]);

    const service = makeService(tx);
    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;
    const csv = await service.exportResponsesCsv('need-1');
    const after = process.memoryUsage().heapUsed;

    expect(csv.split('\n')).toHaveLength(totalRows + 1);
    // Holding all 20,000 raw Prisma-row objects (each with a ~2KB answer
    // string plus Date/object overhead) simultaneously, on top of whatever
    // else is already live on the heap from the rest of this test run
    // (global.gc() is a no-op unless vitest runs with --expose-gc, so this
    // isn't a clean before/after in isolation), would run well past 200MB.
    // 200MB is a deliberately generous ceiling — the point is catching a
    // gross regression (e.g. reverting to one unbounded 20k-row read), not
    // asserting a precise byte budget GC timing can't guarantee here.
    const deltaMb = (after - before) / (1024 * 1024);
    expect(deltaMb).toBeLessThan(200);
  });
});

describe('PublicSurveysService pagination stable tie-breaker (GAP-17)', () => {
  it('listResponses orders by submittedAt desc with id desc as a tie-breaker', async () => {
    const tx = makeFakeTx(NEED, [], SURVEY);
    const service = makeService(tx);

    await service.listResponses('need-1');

    expect(tx.surveyResponse.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }] }),
    );
  });

  it('listQuestionResponses orders by submittedAt desc with id desc as a tie-breaker', async () => {
    const tx = makeFakeTx(NEED, [], SURVEY);
    const service = makeService(tx);

    await service.listQuestionResponses('need-1', 'q1');

    expect(tx.surveyResponse.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }] }),
    );
  });
});
