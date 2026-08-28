import { describe, it, expect } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NeedSummaryService } from './need-summary.service';
import { orgContext } from '../../tenancy/org-context';

const CTX = { requestId: 'r1', orgId: 'org-1', actorId: 'user-1', role: 'human_reviewer' };

const LONG = 'A'.repeat(1600);
const SHORT = 'A'.repeat(400);

type Row = Record<string, unknown>;

/**
 * Fakes just enough of TenantPrismaService for these tests: `runInOrgContext`
 * hands the callback a stub `tx` backed by an in-memory row array, so the
 * assertions are about NeedSummaryService's own decisions (threshold,
 * idempotence, status transitions) rather than about Prisma.
 */
function makeService(opts: {
  need?: Row | null;
  rows?: Row[];
  threshold?: number;
  aiSummary?: string;
  aiThrows?: Error;
} = {}) {
  const need = opts.need === undefined
    ? { id: 'need-1', orgId: 'org-1', studyId: 'study-1', title: 'Water access', statement: LONG }
    : opts.need;
  const rows: Row[] = opts.rows ? [...opts.rows] : [];
  const audits: Row[] = [];
  let seq = 0;

  const tx = {
    need: { findFirst: async () => need },
    needStatementSummary: {
      findFirst: async ({ where }: { where: Row }) =>
        rows.find((r) => matches(r, where)) ?? null,
      findMany: async ({ where }: { where: Row }) => rows.filter((r) => matches(r, where)),
      count: async ({ where }: { where: Row }) => rows.filter((r) => matches(r, where)).length,
      create: async ({ data }: { data: Row }) => {
        const row = {
          id: `sum-${++seq}`,
          reviewerEditedText: null,
          confirmedBy: null,
          confirmedAt: null,
          generatedAt: new Date('2026-08-25T00:00:00Z'),
          ...data,
        };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    },
  };

  const tenant = {
    runInOrgContext: async (fn: (t: typeof tx) => unknown) => fn(tx),
  };
  const ai = {
    run: async () => {
      if (opts.aiThrows) throw opts.aiThrows;
      return { response: { summary: opts.aiSummary ?? 'Short summary.', preservedFacts: [], omittedForLength: false } };
    },
  };
  const audit = { record: async (a: Row) => { audits.push(a); } };
  const methodologyConfig = {
    getRaw: async () => ({
      aiSummarySettings: {
        statementLengthThreshold: opts.threshold ?? 1500,
        maxSummaryChars: 600,
      },
    }),
  };

  return {
    service: new NeedSummaryService(
      tenant as never, ai as never, audit as never, methodologyConfig as never,
    ),
    rows,
    audits,
  };
}

/** Supports the handful of Prisma `where` shapes this service actually uses. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in (v as Row)) {
      return ((v as { in: unknown[] }).in).includes(row[k]);
    }
    if (v && typeof v === 'object' && 'not' in (v as Row)) {
      return row[k] !== (v as { not: unknown }).not;
    }
    return row[k] === v;
  });
}

const run = <T>(fn: () => Promise<T>) => orgContext.run(CTX, fn);

describe('NeedSummaryService — the length threshold (AC 1)', () => {
  it('generates a summary when the statement is above the threshold', async () => {
    const { service, rows } = makeService();
    const result = await run(() => service.maybeGenerateForNeed('need-1', 'manual_entry'));
    expect(result).not.toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.triggerSource).toBe('manual_entry');
  });

  it('does NOT generate when the statement is at or below the threshold', async () => {
    const { service, rows } = makeService({
      need: { id: 'need-1', orgId: 'org-1', studyId: 'study-1', title: 't', statement: SHORT },
    });
    expect(await run(() => service.maybeGenerateForNeed('need-1', 'manual_entry'))).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it('reads the threshold from config, so lowering it changes what triggers', async () => {
    // The same 400-character statement that was ignored above now qualifies.
    const { service, rows } = makeService({
      need: { id: 'need-1', orgId: 'org-1', studyId: 'study-1', title: 't', statement: SHORT },
      threshold: 300,
    });
    expect(await run(() => service.maybeGenerateForNeed('need-1', 'manual_entry'))).not.toBeNull();
    expect(rows).toHaveLength(1);
  });

  it('regenerate ignores the threshold — an explicit human request wins', async () => {
    const { service } = makeService({
      need: { id: 'need-1', orgId: 'org-1', studyId: 'study-1', title: 't', statement: SHORT },
    });
    const result = await run(() => service.regenerate('need-1'));
    expect(result.triggerSource).toBe('manual_regenerate');
  });

  it('skips an empty statement entirely, at any threshold', async () => {
    const { service } = makeService({
      need: { id: 'need-1', orgId: 'org-1', studyId: 'study-1', title: 't', statement: '   ' },
      threshold: 0,
    });
    expect(await run(() => service.maybeGenerateForNeed('need-1', 'manual_entry'))).toBeNull();
  });
});

describe('NeedSummaryService — generation never breaks the caller', () => {
  it('swallows a model failure on the auto path and returns null', async () => {
    const { service, rows } = makeService({ aiThrows: new Error('AI_UNAVAILABLE') });
    expect(await run(() => service.maybeGenerateForNeed('need-1', 'bulk_import'))).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it('but DOES throw on the explicit regenerate path, so the button can report it', async () => {
    const { service } = makeService({ aiThrows: new Error('AI_UNAVAILABLE') });
    await expect(run(() => service.regenerate('need-1'))).rejects.toThrow('AI_UNAVAILABLE');
  });

  it('rejects an empty model response rather than storing a blank summary', async () => {
    const { service, rows } = makeService({ aiSummary: '   ' });
    await expect(run(() => service.regenerate('need-1'))).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('throws NotFound for a need outside the caller org', async () => {
    const { service } = makeService({ need: null });
    await expect(run(() => service.regenerate('need-1'))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('NeedSummaryService — idempotence on the auto path', () => {
  it('does not re-run the model when a live summary already covers this exact text', async () => {
    const { service, rows } = makeService();
    await run(() => service.maybeGenerateForNeed('need-1', 'bulk_import'));
    await run(() => service.maybeGenerateForNeed('need-1', 'bulk_import'));
    expect(rows).toHaveLength(1);
  });

  it('supersedes an older draft when a new summary is generated explicitly', async () => {
    const { service, rows } = makeService();
    await run(() => service.maybeGenerateForNeed('need-1', 'manual_entry'));
    await run(() => service.regenerate('need-1'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe('SUPERSEDED');
    expect(rows[1]?.status).toBe('DRAFT');
  });
});

describe('NeedSummaryService — the AI text is never overwritten (AC 2 + AC 4)', () => {
  it('an edit writes a separate column and leaves aiSummaryText intact', async () => {
    const { service, rows } = makeService({ aiSummary: 'AI wrote this.' });
    const draft = await run(() => service.regenerate('need-1'));

    const edited = await run(() => service.updateDraft(draft.id, 'Reviewer rewrote this.'));

    expect(edited.aiSummaryText).toBe('AI wrote this.');
    expect(edited.reviewerEditedText).toBe('Reviewer rewrote this.');
    expect(edited.effectiveText).toBe('Reviewer rewrote this.');
    expect(edited.wasEdited).toBe(true);
    expect(rows[0]?.aiSummaryText).toBe('AI wrote this.');
  });

  it('an unedited summary reports wasEdited false and falls back to the AI text', async () => {
    const { service } = makeService({ aiSummary: 'AI wrote this.' });
    const draft = await run(() => service.regenerate('need-1'));
    expect(draft.wasEdited).toBe(false);
    expect(draft.effectiveText).toBe('AI wrote this.');
  });

  it('keeps the original statement on the row and returns it on every read', async () => {
    const { service } = makeService();
    const draft = await run(() => service.regenerate('need-1'));
    expect(draft.sourceStatement).toBe(LONG);
    expect(draft.sourceLength).toBe(LONG.length);
  });

  it('refuses to save an empty edit', async () => {
    const { service } = makeService();
    const draft = await run(() => service.regenerate('need-1'));
    await expect(run(() => service.updateDraft(draft.id, '   ')))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('NeedSummaryService — explicit confirmation (AC 3)', () => {
  it('a freshly generated summary is DRAFT, never confirmed', async () => {
    const { service } = makeService();
    const draft = await run(() => service.regenerate('need-1'));
    expect(draft.status).toBe('DRAFT');
    expect(draft.confirmedAt).toBeNull();
  });

  it('confirm moves it to CONFIRMED and stamps who and when', async () => {
    const { service } = makeService();
    const draft = await run(() => service.regenerate('need-1'));
    const confirmed = await run(() => service.confirm(draft.id));
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.confirmedBy).toBe('user-1');
    expect(confirmed.confirmedAt).not.toBeNull();
  });

  it('a summary cannot be confirmed twice', async () => {
    const { service } = makeService();
    const draft = await run(() => service.regenerate('need-1'));
    await run(() => service.confirm(draft.id));
    await expect(run(() => service.confirm(draft.id))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a confirmed summary cannot be edited', async () => {
    const { service } = makeService();
    const draft = await run(() => service.regenerate('need-1'));
    await run(() => service.confirm(draft.id));
    await expect(run(() => service.updateDraft(draft.id, 'late edit')))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('records generate, edit and confirm as three separate audit entries', async () => {
    const { service, audits } = makeService();
    const draft = await run(() => service.regenerate('need-1'));
    await run(() => service.updateDraft(draft.id, 'edited'));
    await run(() => service.confirm(draft.id));
    expect(audits.map((a) => a.action)).toEqual([
      'generate_need_summary',
      'edit_need_summary',
      'confirm_need_summary',
    ]);
  });
});

describe('NeedSummaryService — bulk confirm', () => {
  it('confirms every id and reports which ones did not take', async () => {
    const { service, rows } = makeService();
    const a = await run(() => service.regenerate('need-1'));
    // A second need's draft, added directly so both are DRAFT at once.
    rows.push({
      id: 'sum-other', orgId: 'org-1', needId: 'need-2', studyId: 'study-1',
      status: 'DRAFT', promptVersion: 'p', modelName: 'm', modelVersion: 'v',
      sourceStatement: LONG, sourceLength: LONG.length, inputTextHash: 'h2',
      aiSummaryText: 'x', reviewerEditedText: null, triggerSource: 'bulk_import',
      generatedAt: new Date('2026-08-25T00:00:00Z'), confirmedBy: null, confirmedAt: null,
    });

    const result = await run(() => service.confirmMany([a.id, 'sum-other', 'sum-missing']));

    expect(result.confirmed).toEqual([a.id, 'sum-other']);
    expect(result.skipped).toEqual(['sum-missing']);
  });

  it('one bad id does not abort the rest', async () => {
    const { service } = makeService();
    const a = await run(() => service.regenerate('need-1'));
    const result = await run(() => service.confirmMany(['sum-missing', a.id]));
    expect(result.confirmed).toEqual([a.id]);
  });

  it('rethrows an infrastructure failure instead of reporting it as "skipped"', async () => {
    // Absorbing this would tell the reviewer "already decided or replaced" for
    // every id — a specific, wrong explanation of a database outage, and they
    // would believe the batch was handled.
    const { service, rows } = makeService();
    const a = await run(() => service.regenerate('need-1'));
    rows.length = 0; // make the lookup throw rather than return null
    const boom = new Error('connection terminated unexpectedly');
    // Reaching past `private` is the point: the failure being simulated is one
    // the public surface cannot produce on demand.
    (service as unknown as Record<string, unknown>).findDraftOrThrow = () => Promise.reject(boom);

    await expect(run(() => service.confirmMany([a.id]))).rejects.toThrow(boom);
  });
});

describe('NeedSummaryService — what reaches a report', () => {
  it('returns null while the summary is still a draft, so reports use the original', async () => {
    const { service } = makeService();
    await run(() => service.regenerate('need-1'));
    expect(await run(() => service.getConfirmedTextForNeed('need-1'))).toBeNull();
  });

  it('returns the confirmed text once a reviewer has signed it off', async () => {
    const { service } = makeService({ aiSummary: 'AI text.' });
    const draft = await run(() => service.regenerate('need-1'));
    await run(() => service.confirm(draft.id));
    expect(await run(() => service.getConfirmedTextForNeed('need-1'))).toBe('AI text.');
  });

  it('prefers the reviewer edit over the AI text', async () => {
    const { service } = makeService({ aiSummary: 'AI text.' });
    const draft = await run(() => service.regenerate('need-1'));
    await run(() => service.updateDraft(draft.id, 'Reviewer text.'));
    await run(() => service.confirm(draft.id));
    expect(await run(() => service.getConfirmedTextForNeed('need-1'))).toBe('Reviewer text.');
  });

  it('stops returning a confirmed summary once the statement changes under it', async () => {
    const { service } = makeService({ aiSummary: 'AI text.' });
    const draft = await run(() => service.regenerate('need-1'));
    await run(() => service.confirm(draft.id));

    await run(() => service.markStaleForNeed('need-1'));

    // The decision itself survives for audit — it is marked STALE, not deleted —
    // but a stale wording must never reach a freshly generated report.
    expect(await run(() => service.getConfirmedTextForNeed('need-1'))).toBeNull();
  });
});
