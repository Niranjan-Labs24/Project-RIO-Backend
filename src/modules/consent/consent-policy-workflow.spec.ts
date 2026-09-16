import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentService } from './consent.service';
import { orgContext } from '../../tenancy/org-context';

/**
 * Client-confirmed (2026-08-27) — consent policies are dynamically managed
 * and versioned in V2, not hardcoded per release:
 *
 *   2. System Admin drafts, creates and updates policy versions.
 *   3. A System Reviewer sign-off gate stands between a draft and signup.
 *   4. Full version history is retained, and a user's consent stays tied to
 *      the version that was active when they gave it — a previously active
 *      version stays valid and is never silently upgraded.
 *   5. All of it lands in the audit log.
 *
 * (2) and (3) are RBAC, enforced by @RequirePermission on the controller and
 * asserted in the RBAC suite; what this file pins down is the state machine
 * those permissions gate — that no path reaches `published` without passing
 * through a reviewer, and that publishing a successor leaves its predecessor
 * intact rather than rewriting it.
 */

type Status = 'draft' | 'pending_approval' | 'approved' | 'published';

interface Row {
  id: string;
  kind: 'use_policy' | 'data_sharing';
  version: string;
  text: string;
  textAr: string | null;
  status: Status;
  active: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedBy: string | null;
  updatedAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  publishedBy: string | null;
  publishedAt: Date | null;
}

const ADMIN_ID = '00000000-0000-0000-0000-0000000000aa';
const REVIEWER_ID = '00000000-0000-0000-0000-0000000000bb';

function row(overrides: Partial<Row> & Pick<Row, 'id' | 'version'>): Row {
  return {
    kind: 'use_policy',
    text: 'Policy text',
    textAr: null,
    status: 'draft',
    active: false,
    createdBy: ADMIN_ID,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedBy: ADMIN_ID,
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
    publishedBy: null,
    publishedAt: null,
    ...overrides,
  };
}

/**
 * An in-memory `consent_policies` that mutates in place, so a test can assert
 * on what the *other* rows look like after a write — which is the whole point
 * for publish(), where the interesting effect is on the row that was NOT
 * passed in.
 */
function fakePrisma(seed: Row[]) {
  const rows = seed.map((r) => ({ ...r }));
  let nextId = 100;

  const match = (r: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v);

  const consentPolicy = {
    findMany: vi.fn(async () =>
      [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    ),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((r) => match(r, where)) ?? null,
    ),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      rows.find((r) => r.id === where.id) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
      const created = row({
        id: `new-${(nextId += 1)}`,
        version: data.version as string,
        ...data,
      } as Partial<Row> & Pick<Row, 'id' | 'version'>);
      rows.push(created);
      return created;
    }),
    // Returns a thunk-free value like Prisma's own, and applies the mutation
    // eagerly so $transaction below can simply await the array it is handed.
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const target = rows.find((r) => r.id === where.id);
      if (!target) throw new Error(`no row ${where.id}`);
      Object.assign(target, data);
      return { ...target };
    }),
  };

  return {
    prisma: {
      consentPolicy,
      $transaction: (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
    },
    rows,
    consentPolicy,
  };
}

const fakeTenant = {
  runAsSupervisor: async (fn: (tx: unknown) => unknown) =>
    fn({ user: { findMany: async () => [{ id: ADMIN_ID, name: 'Admin One' }] } }),
};

function makeService(seed: Row[]) {
  const { prisma, rows, consentPolicy } = fakePrisma(seed);
  const audit = { record: vi.fn(async () => undefined) };
  const svc = new ConsentService(prisma as never, fakeTenant as never, audit as never);
  return { svc, rows, audit, consentPolicy };
}

/** Every workflow method calls requireActor(), which reads the AsyncLocalStorage store. */
function asActor<T>(actorId: string, fn: () => Promise<T>): Promise<T> {
  return orgContext.run(
    { orgId: '00000000-0000-0000-0000-000000000001', actorId } as never,
    fn,
  );
}

describe('ConsentService — draft authoring', () => {
  it('creates a draft that is neither published nor active', async () => {
    const { svc, rows } = makeService([]);

    const created = await asActor(ADMIN_ID, () =>
      svc.createDraft({ kind: 'use_policy', version: 'v2', text: 'Revised terms' }),
    );

    expect(created.status).toBe('draft');
    expect(created.active).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it('rejects a version label already used for that kind', async () => {
    const { svc } = makeService([row({ id: 'a', version: 'v1', status: 'published' })]);

    await expect(
      asActor(ADMIN_ID, () =>
        svc.createDraft({ kind: 'use_policy', version: 'v1', text: 'Duplicate' }),
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'CONSENT_VERSION_EXISTS' } } });
  });

  it('allows the same label across the two kinds — versions are per-kind', async () => {
    const { svc } = makeService([row({ id: 'a', version: 'v1', status: 'published' })]);

    await expect(
      asActor(ADMIN_ID, () =>
        svc.createDraft({ kind: 'data_sharing', version: 'v1', text: 'Sharing terms' }),
      ),
    ).resolves.toMatchObject({ kind: 'data_sharing', version: 'v1' });
  });

  it('stores a blank Arabic box as "not translated yet", not as empty Arabic text', async () => {
    const { svc } = makeService([]);

    const created = await asActor(ADMIN_ID, () =>
      svc.createDraft({ kind: 'use_policy', version: 'v2', text: 'Terms', textAr: '   ' }),
    );

    expect(created.textAr).toBeNull();
  });
});

describe('ConsentService — the approval gate', () => {
  it('refuses to publish a version no reviewer has approved', async () => {
    const { svc } = makeService([row({ id: 'a', version: 'v2', status: 'pending_approval' })]);

    await expect(asActor(ADMIN_ID, () => svc.publishVersion('a'))).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      asActor(ADMIN_ID, () => svc.publishVersion('a')),
    ).rejects.toMatchObject({ response: { error: { code: 'CONSENT_POLICY_NOT_APPROVED' } } });
  });

  it('refuses to approve something that is not awaiting review', async () => {
    const { svc } = makeService([row({ id: 'a', version: 'v2', status: 'draft' })]);

    await expect(
      asActor(REVIEWER_ID, () => svc.approveVersion('a', 'Looks fine')),
    ).rejects.toMatchObject({
      response: { error: { code: 'CONSENT_POLICY_NOT_PENDING_APPROVAL' } },
    });
  });

  it.each([
    ['approveVersion' as const, '   '],
    ['rejectVersion' as const, '\n\t'],
  ])('requires non-blank reviewer notes on %s', async (method, notes) => {
    const { svc } = makeService([row({ id: 'a', version: 'v2', status: 'pending_approval' })]);

    await expect(asActor(REVIEWER_ID, () => svc[method]('a', notes))).rejects.toMatchObject({
      response: { error: { code: 'REVIEWER_NOTES_REQUIRED' } },
    });
  });

  it('sends a rejected version back to draft, keeping the reviewer note', async () => {
    const { svc } = makeService([row({ id: 'a', version: 'v2', status: 'pending_approval' })]);

    const rejected = await asActor(REVIEWER_ID, () =>
      svc.rejectVersion('a', 'Clause 4 conflicts with PDPL.'),
    );

    expect(rejected.status).toBe('draft');
    expect(rejected.reviewNotes).toBe('Clause 4 conflicts with PDPL.');
  });

  it('re-opens the gate when an approved version is edited before publishing', async () => {
    const { svc } = makeService([
      row({
        id: 'a',
        version: 'v2',
        status: 'approved',
        reviewedBy: REVIEWER_ID,
        reviewedAt: new Date('2026-08-10T00:00:00Z'),
        reviewNotes: 'Approved',
      }),
    ]);

    const edited = await asActor(ADMIN_ID, () =>
      svc.updateDraft('a', { text: 'Reworded after approval' }),
    );

    // The reviewer signed off on wording, not on a row id.
    expect(edited.status).toBe('draft');
    expect(edited.reviewNotes).toBeNull();
    expect(edited.reviewedByName).toBeNull();
  });

  it('refuses to edit a published version — supersede it instead', async () => {
    const { svc } = makeService([
      row({ id: 'a', version: 'v1', status: 'published', active: true }),
    ]);

    await expect(
      asActor(ADMIN_ID, () => svc.updateDraft('a', { text: 'Quietly rewritten' })),
    ).rejects.toMatchObject({ response: { error: { code: 'CONSENT_POLICY_PUBLISHED' } } });
  });

  it('404s on a version that no longer exists', async () => {
    const { svc } = makeService([]);

    await expect(
      asActor(ADMIN_ID, () => svc.submitForApproval('missing')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ConsentService.publishVersion', () => {
  it('runs the full draft → submit → approve → publish path', async () => {
    const { svc, rows } = makeService([]);

    const draft = await asActor(ADMIN_ID, () =>
      svc.createDraft({ kind: 'use_policy', version: 'v2', text: 'Revised terms' }),
    );
    await asActor(ADMIN_ID, () => svc.submitForApproval(draft.id));
    await asActor(REVIEWER_ID, () => svc.approveVersion(draft.id, 'PDPL review passed.'));
    const published = await asActor(ADMIN_ID, () => svc.publishVersion(draft.id));

    expect(published.status).toBe('published');
    expect(published.active).toBe(true);
    expect(rows[0]!.publishedAt).not.toBeNull();
  });

  it('deactivates the predecessor without rewriting it — prior consents stay valid', async () => {
    const { svc, rows } = makeService([
      row({
        id: 'v1',
        version: 'v1',
        status: 'published',
        active: true,
        publishedAt: new Date('2026-01-01T00:00:00Z'),
      }),
      row({ id: 'v2', version: 'v2', status: 'approved' }),
    ]);

    await asActor(ADMIN_ID, () => svc.publishVersion('v2'));

    const previous = rows.find((r) => r.id === 'v1')!;
    // Deactivated, but still `published` and still carrying its own text: the
    // client was explicit that "the previously active version stays valid for
    // anyone who consented under it; it doesn't need to be silently upgraded."
    expect(previous.active).toBe(false);
    expect(previous.status).toBe('published');
    expect(previous.version).toBe('v1');
    expect(rows.find((r) => r.id === 'v2')!.active).toBe(true);
  });

  it('leaves the other kind’s active version alone', async () => {
    const { svc, rows } = makeService([
      row({ id: 'share-v1', kind: 'data_sharing', version: 'v1', status: 'published', active: true }),
      row({ id: 'use-v2', version: 'v2', status: 'approved' }),
    ]);

    await asActor(ADMIN_ID, () => svc.publishVersion('use-v2'));

    expect(rows.find((r) => r.id === 'share-v1')!.active).toBe(true);
  });
});

describe('ConsentService — audit trail (client requirement 5)', () => {
  let audit: { record: ReturnType<typeof vi.fn> };
  let svc: ConsentService;

  beforeEach(() => {
    const made = makeService([]);
    svc = made.svc;
    audit = made.audit;
  });

  it('records every step of the lifecycle against the consent_policy entity', async () => {
    const draft = await asActor(ADMIN_ID, () =>
      svc.createDraft({ kind: 'use_policy', version: 'v2', text: 'Revised terms' }),
    );
    await asActor(ADMIN_ID, () => svc.updateDraft(draft.id, { text: 'Revised terms, again' }));
    await asActor(ADMIN_ID, () => svc.submitForApproval(draft.id));
    await asActor(REVIEWER_ID, () => svc.approveVersion(draft.id, 'Signed off.'));
    await asActor(ADMIN_ID, () => svc.publishVersion(draft.id));

    expect(audit.record).toHaveBeenCalledTimes(5);
    for (const [entry] of audit.record.mock.calls) {
      expect(entry.entityType).toBe('consent_policy');
      expect(entry.entityId).toBe(draft.id);
      // RIO-FR-007 — before/after is never dropped (see
      // audit-change-coverage.spec.ts, which enforces the same at lint level).
      expect(entry.changes.length).toBeGreaterThan(0);
    }
    expect(audit.record.mock.calls.map(([e]) => e.action)).toEqual([
      'create',
      'edit',
      'edit',
      'approve',
      'approve',
    ]);
  });

  it('names the policy and the outcome in the entity label, not just the id', async () => {
    const draft = await asActor(ADMIN_ID, () =>
      svc.createDraft({ kind: 'data_sharing', version: 'v3', text: 'Sharing terms' }),
    );
    await asActor(ADMIN_ID, () => svc.submitForApproval(draft.id));
    await asActor(REVIEWER_ID, () => svc.rejectVersion(draft.id, 'Needs legal input.'));

    const labels = audit.record.mock.calls.map(([e]) => e.entityLabel as string);
    expect(labels[0]).toBe('Data Sharing Policy v3 drafted');
    expect(labels[2]).toBe('Data Sharing Policy v3 rejected');
  });

  it('does not copy the policy body into the audit record', async () => {
    const body = 'x'.repeat(5000);
    await asActor(ADMIN_ID, () =>
      svc.createDraft({ kind: 'use_policy', version: 'v9', text: body }),
    );

    const [entry] = audit.record.mock.calls[0]!;
    // The row it points at is immutable once published, so the entity id is a
    // better reference than a 5,000-character duplicate in every log row.
    expect(JSON.stringify(entry)).not.toContain(body);
    expect(entry.metadata.textLength).toBe(5000);
  });
});

describe('ConsentService.listVersions', () => {
  it('splits history by kind, newest first, drafts included', async () => {
    const { svc } = makeService([
      row({
        id: 'a',
        version: 'v1',
        status: 'published',
        active: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
      row({ id: 'b', version: 'v2', createdAt: new Date('2026-08-01T00:00:00Z') }),
      row({
        id: 'c',
        kind: 'data_sharing',
        version: 'v1',
        status: 'published',
        active: true,
        createdAt: new Date('2026-02-01T00:00:00Z'),
      }),
    ]);

    const list = await svc.listVersions();

    expect(list.usePolicy.map((v) => v.version)).toEqual(['v2', 'v1']);
    expect(list.dataSharing.map((v) => v.version)).toEqual(['v1']);
    // Resolved through the cross-org supervisor path, since `users` is
    // RLS-scoped and this table has no org context of its own.
    expect(list.usePolicy[0]!.createdByName).toBe('Admin One');
  });
});
