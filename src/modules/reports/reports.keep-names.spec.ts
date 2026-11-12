import { describe, expect, it, vi } from 'vitest';
import { ReportsService } from './reports.service';

// UAT GEN-03 — the names a report keeps as entered are its own organisation's
// and study's, not every organisation on the platform.
describe('ReportsService keepNames', () => {
  function build() {
    const organisationFindMany = vi
      .fn()
      .mockResolvedValue([{ name: 'Water' }, { name: 'Owner Org' }]);
    const studyFindUnique = vi
      .fn()
      .mockResolvedValue({ title: 'Study A', org: { name: 'Owner Org' } });
    const tx = {
      organisation: { findMany: organisationFindMany },
      study: { findUnique: studyFindUnique },
    };
    const tenant = { runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx) };
    const service = new ReportsService(
      tenant as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const keepNames = (studyId: string | null) =>
      (service as unknown as { keepNames(id: string | null): Promise<string[]> }).keepNames(
        studyId,
      );
    return { keepNames, organisationFindMany };
  }

  it("keeps only the study's own organisation and title", async () => {
    const { keepNames, organisationFindMany } = build();
    expect(await keepNames('study-1')).toEqual(['Owner Org', 'Study A']);
    // Another organisation named with a common word no longer freezes that word.
    expect(organisationFindMany).not.toHaveBeenCalled();
  });

  it('keeps every organisation name for a report with no study', async () => {
    const { keepNames } = build();
    expect(await keepNames(null)).toEqual(['Water', 'Owner Org']);
  });
});
