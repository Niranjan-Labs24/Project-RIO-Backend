import { describe, expect, it } from 'vitest';
import { buildPlaceholderReport, isPlaceholderReport } from './reports.placeholder';

describe('placeholder reports (GAP-05)', () => {
  it('emit no fabricated metric figures', () => {
    const { content } = buildPlaceholderReport('RPT08');
    // The invented "24 / 92% / 8 Governorates" metrics array must be gone.
    expect(content.metrics).toBeUndefined();
    expect(content.isPlaceholder).toBe(true);
  });

  it('isPlaceholderReport detects the flag', () => {
    expect(isPlaceholderReport({ isPlaceholder: true })).toBe(true);
    expect(isPlaceholderReport({ isPlaceholder: false })).toBe(false);
    expect(isPlaceholderReport({})).toBe(false);
    expect(isPlaceholderReport(null)).toBe(false);
  });
});
