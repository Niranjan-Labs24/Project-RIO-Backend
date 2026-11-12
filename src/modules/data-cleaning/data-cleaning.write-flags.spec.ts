import { describe, expect, it } from 'vitest';
import { makeFakeTx } from '../../../test/support/fake-tx';
import { DataCleaningService } from './data-cleaning.service';

/**
 * UAT DQ-01 — "the decision selected is not being applied". A re-run of the
 * rules (any edit to a need) used to raise a finding the reviewer had already
 * rejected as a brand-new pending flag, because only pending flags were
 * looked up. These pin the decided behaviour.
 */
type WriteFlags = (
  tx: unknown,
  input: {
    runId: string;
    orgId: string;
    source: string;
    studyId: string | null;
    flags: Record<string, unknown>[];
    scope: { entityType: string; entityIds: string[] };
  },
) => Promise<{ flagsRaised: number; flagsSuperseded: number }>;

function setup() {
  const tx = makeFakeTx();
  const svc = new DataCleaningService({} as never, {} as never, {} as never);
  const writeFlags = (svc as unknown as { writeFlags: WriteFlags }).writeFlags.bind(svc);
  return { tx, writeFlags };
}

const finding = (originalValue: string) => ({
  entityType: 'need',
  entityId: 'n1',
  rowNumber: null,
  field: 'village[0]',
  ruleCode: 'VILLAGE_UNMATCHED',
  severity: 'out_of_vocabulary',
  originalValue,
  proposedValue: null,
  confidence: null,
  detail: null,
});

const input = (flags: Record<string, unknown>[]) => ({
  runId: 'run',
  orgId: 'o1',
  source: 'manual_entry',
  studyId: 's1',
  flags,
  scope: { entityType: 'need', entityIds: ['n1'] },
});

describe('DataCleaningService.writeFlags — reviewer decisions survive a re-run (UAT DQ-01)', () => {
  it('does not raise again a finding the reviewer rejected for the same value', async () => {
    const { tx, writeFlags } = setup();
    tx.cleaningFlag.findMany.mockImplementation(async ({ where }: { where: { status: string } }) =>
      where.status === 'rejected'
        ? [{ entityId: 'n1', field: 'village[0]', ruleCode: 'VILLAGE_UNMATCHED', originalValue: 'Al Noor' }]
        : [],
    );

    const result = await writeFlags(tx, input([finding('Al Noor')]));

    expect(result.flagsRaised).toBe(0);
    expect(tx.cleaningFlag.create).not.toHaveBeenCalled();
  });

  it('raises it again once the value has changed — that is a new finding', async () => {
    const { tx, writeFlags } = setup();
    tx.cleaningFlag.findMany.mockImplementation(async ({ where }: { where: { status: string } }) =>
      where.status === 'rejected'
        ? [{ entityId: 'n1', field: 'village[0]', ruleCode: 'VILLAGE_UNMATCHED', originalValue: 'Al Noor' }]
        : [],
    );

    const result = await writeFlags(tx, input([finding('Al Noor Village')]));

    expect(result.flagsRaised).toBe(1);
    expect(tx.cleaningFlag.create).toHaveBeenCalledTimes(1);
  });
});
