import { NotesRepository } from './notes.repository';

describe('NotesRepository', () => {
  it('lists notes through the tenancy layer, mapping rows to NoteView', async () => {
    const rows = [{ id: 'n1', body: 'hi', createdAt: new Date('2026-01-01T00:00:00Z') }];
    const tenant = {
      runInOrgContext: (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ note: { findMany: () => Promise.resolve(rows) } }),
    };
    const repo = new NotesRepository(tenant as never);
    const result = await repo.list();
    expect(result).toEqual([{ id: 'n1', body: 'hi', createdAt: '2026-01-01T00:00:00.000Z' }]);
  });

  it('creates a note through the tenancy layer via a RETURNING insert', async () => {
    // The repository derives org_id from the session GUC and inserts with raw SQL,
    // so the fake tx exposes $queryRaw returning the inserted row (as an array).
    const created = [{ id: 'n2', body: 'new', createdAt: new Date('2026-02-02T00:00:00Z') }];
    const tenant = {
      runInOrgContext: (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $queryRaw: () => Promise.resolve(created) }),
    };
    const repo = new NotesRepository(tenant as never);
    const result = await repo.create({ body: 'new' });
    expect(result).toEqual({ id: 'n2', body: 'new', createdAt: '2026-02-02T00:00:00.000Z' });
  });
});
