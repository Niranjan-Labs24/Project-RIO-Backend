import { describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { NeedThemesService } from './need-themes.service';
import { orgContext } from '../../tenancy/org-context';

const CTX = { requestId: 'r1', orgId: 'org-1', actorId: 'user-1', role: 'data_analyst' };
const run = <T>(fn: () => Promise<T>) => orgContext.run(CTX, fn);

const VOCAB = ['Distance to facility', 'Transport availability', 'Water availability'];

function makeService(opts: {
  need?: Record<string, unknown> | null;
  vocabulary?: string[];
  aiThemes?: string[];
  aiThrows?: Error;
  otherNeeds?: Array<{ id: string; themes: string[] }>;
} = {}) {
  const need =
    opts.need === undefined
      ? { id: 'need-1', orgId: 'org-1', title: 'Health access', statement: 'Clinic is far.', themes: [] }
      : opts.need;
  const others = opts.otherNeeds ?? [];
  const writes: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];

  const tx = {
    need: {
      findFirst: async () => need,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return { ...need, ...data };
      },
      count: async ({ where }: { where: { themes?: { hasSome: string[] } } }) => {
        const wanted = where.themes?.hasSome ?? [];
        return others.filter((n) => n.themes.some((t) => wanted.includes(t))).length;
      },
      findMany: async () => others.map((n) => ({ themes: n.themes })),
    },
  };

  const tenant = { runInOrgContext: async (fn: (t: typeof tx) => unknown) => fn(tx) };
  const ai = {
    run: async () => {
      if (opts.aiThrows) throw opts.aiThrows;
      return { response: { themes: opts.aiThemes ?? [], rationale: 'because' } };
    },
  };
  const audit = { record: async (a: Record<string, unknown>) => { audits.push(a); } };
  const studyConfig = {
    listActiveNeedThemeNames: async () => opts.vocabulary ?? VOCAB,
  };

  return {
    service: new NeedThemesService(
      tenant as never, ai as never, audit as never, studyConfig as never,
    ),
    writes,
    audits,
  };
}

describe('NeedThemesService — extraction stays inside the vocabulary', () => {
  it('keeps themes that are in the approved list', async () => {
    const { service, writes } = makeService({ aiThemes: ['Distance to facility'] });
    expect(await run(() => service.extract('need-1'))).toEqual(['Distance to facility']);
    expect(writes[0]?.themes).toEqual(['Distance to facility']);
  });

  it('drops an invented theme even though the prompt forbids it', async () => {
    // The prompt says not to invent, but a filter built on model compliance is
    // not a filter. A hallucinated theme would create a group of one.
    const { service } = makeService({
      aiThemes: ['Distance to facility', 'Roads are bad'],
    });
    expect(await run(() => service.extract('need-1'))).toEqual(['Distance to facility']);
  });

  it('de-duplicates a repeated theme', async () => {
    const { service } = makeService({
      aiThemes: ['Water availability', 'Water availability'],
    });
    expect(await run(() => service.extract('need-1'))).toEqual(['Water availability']);
  });

  it('caps at three, so one need cannot dominate every theme group', async () => {
    const { service } = makeService({
      vocabulary: ['a', 'b', 'c', 'd', 'e'],
      aiThemes: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(await run(() => service.extract('need-1'))).toHaveLength(3);
  });

  it('returns nothing when no vocabulary is configured, rather than asking the model to invent one', async () => {
    const { service, writes } = makeService({ vocabulary: [], aiThemes: ['anything'] });
    expect(await run(() => service.extract('need-1'))).toEqual([]);
    expect(writes).toHaveLength(0);
  });

  it('skips an empty statement', async () => {
    const { service } = makeService({
      need: { id: 'need-1', orgId: 'org-1', title: 't', statement: '   ', themes: [] },
    });
    expect(await run(() => service.extract('need-1'))).toEqual([]);
  });

  it('throws NotFound for a need outside the caller org', async () => {
    const { service } = makeService({ need: null });
    await expect(run(() => service.extract('need-1'))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('NeedThemesService — generation never breaks the caller', () => {
  it('swallows a model failure on the auto path', async () => {
    const { service } = makeService({ aiThrows: new Error('AI_UNAVAILABLE') });
    expect(await run(() => service.maybeExtractForNeed('need-1'))).toBeNull();
  });

  it('but throws on the explicit re-extract, so the button can report it', async () => {
    const { service } = makeService({ aiThrows: new Error('AI_UNAVAILABLE') });
    await expect(run(() => service.extract('need-1'))).rejects.toThrow('AI_UNAVAILABLE');
  });
});

describe('NeedThemesService — audit', () => {
  it('records a theme change', async () => {
    const { service, audits } = makeService({ aiThemes: ['Water availability'] });
    await run(() => service.extract('need-1'));
    expect(audits[0]).toMatchObject({ action: 'extract_need_themes', entityType: 'need' });
  });

  it('does not record when the themes came back identical', async () => {
    // Re-extraction is idempotent in practice (temperature 0), and an audit
    // entry per re-run would bury the changes that matter.
    const { service, audits } = makeService({
      need: { id: 'need-1', orgId: 'org-1', title: 't', statement: 'x', themes: ['Water availability'] },
      aiThemes: ['Water availability'],
    });
    await run(() => service.extract('need-1'));
    expect(audits).toHaveLength(0);
  });
});

describe('NeedThemesService — the recurrence count', () => {
  it('counts needs that share at least one theme', async () => {
    const { service } = makeService({
      otherNeeds: [
        { id: 'n2', themes: ['Distance to facility'] },
        { id: 'n3', themes: ['Distance to facility', 'Transport availability'] },
        { id: 'n4', themes: ['Water availability'] },
      ],
    });
    const count = await run(() =>
      service.countSharingThemes('need-1', ['Distance to facility']),
    );
    expect(count).toBe(2);
  });

  it('counts a need once even when it shares several themes', async () => {
    // Counting theme hits instead would let one richly-tagged need look like a
    // region-wide pattern.
    const { service } = makeService({
      otherNeeds: [{ id: 'n2', themes: ['Distance to facility', 'Transport availability'] }],
    });
    const count = await run(() =>
      service.countSharingThemes('need-1', ['Distance to facility', 'Transport availability']),
    );
    expect(count).toBe(1);
  });

  it('is 0 for a need with no themes, without querying', async () => {
    const { service } = makeService({ otherNeeds: [{ id: 'n2', themes: ['x'] }] });
    expect(await run(() => service.countSharingThemes('need-1', []))).toBe(0);
  });
});

describe('NeedThemesService — grouping (AC 6)', () => {
  it('returns each theme with its need count, most widespread first', async () => {
    const { service } = makeService({
      otherNeeds: [
        { id: 'n1', themes: ['Distance to facility'] },
        { id: 'n2', themes: ['Distance to facility', 'Water availability'] },
        { id: 'n3', themes: ['Distance to facility'] },
      ],
    });
    expect(await run(() => service.listThemeCounts())).toEqual([
      { theme: 'Distance to facility', needCount: 3 },
      { theme: 'Water availability', needCount: 1 },
    ]);
  });

  it('is empty when nothing has been extracted yet', async () => {
    const { service } = makeService({ otherNeeds: [] });
    expect(await run(() => service.listThemeCounts())).toEqual([]);
  });
});
