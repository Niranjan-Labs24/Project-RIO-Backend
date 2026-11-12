import { describe, expect, it } from 'vitest';
import { nameMask } from './keep-names';

describe('nameMask', () => {
  it('round-trips a name nested inside a longer one', () => {
    const m = nameMask(['Al Noor Society', 'Al Noor Society Water Access 2026']);
    const src = 'The study Al Noor Society Water Access 2026 covers three villages.';
    const masked = m.mask(src);
    expect(masked).toEqual({ text: 'The study ⟦0⟧ covers three villages.', count: 1 });
    expect(m.unmask(src, 'الدراسة ⟦0⟧ تغطي ثلاث قرى.')).toBe(
      'الدراسة Al Noor Society Water Access 2026 تغطي ثلاث قرى.',
    );
  });

  it('masks two independent names in one string', () => {
    const m = nameMask(['Al Noor Society', 'Water Access 2026']);
    const src = 'Al Noor Society ran Water Access 2026.';
    const masked = m.mask(src);
    expect(masked.count).toBe(2);
    expect(m.unmask(src, masked.text.replace('ran', 'نفّذت'))).toBe(
      'Al Noor Society نفّذت Water Access 2026.',
    );
  });

  it('returns null when the translator really drops a placeholder', () => {
    const m = nameMask(['Al Noor Society']);
    expect(m.unmask('Al Noor Society report', 'تقرير')).toBeNull();
  });
});
