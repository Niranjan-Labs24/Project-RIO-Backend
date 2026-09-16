import { describe, expect, it } from 'vitest';
import { parseCsvNeeds } from './needs-import.parser';
import { parseAffectedPopulationCell } from './needs-import.service';

// RIO-RPT-001 Option A: the need-entry question also has to survive the bulk
// path, or an import becomes a way to lose the one field the Top-Priority
// Report's Affected Population column depends on.
describe('needs import — affected population', () => {
  const csv = (body: string) => parseCsvNeeds(Buffer.from(body, 'utf-8'));

  it('reads the column when the file has it', () => {
    const rows = csv(
      'Title,Statement,Village,Affected Population\nWater,Households walk an hour,Kadapa,450\n',
    );
    expect(rows[0]?.affectedPopulation).toBe('450');
  });

  // A file written before the column existed must import exactly as it always
  // did — the field is optional everywhere it appears.
  it('leaves it empty when the file does not have the column', () => {
    const rows = csv('Title,Statement,Village\nWater,Households walk an hour,Kadapa\n');
    expect(rows[0]?.affectedPopulation).toBe('');
    expect(rows[0]?.title).toBe('Water');
  });

  it('accepts the spellings a spreadsheet is likely to use', () => {
    for (const header of ['People Affected', 'Number of people affected', 'population affected']) {
      const rows = csv(`Title,Statement,Village,${header}\nWater,Statement,Kadapa,120\n`);
      expect(rows[0]?.affectedPopulation).toBe('120');
    }
  });

  describe('parseAffectedPopulationCell', () => {
    // Blank is a legitimate answer, not an error: the report prints a dash and
    // says why. Rejecting it would force people to invent a number.
    it('treats a blank cell as "not answered", not as an error', () => {
      expect(parseAffectedPopulationCell('')).toEqual({ ok: true, value: null });
      expect(parseAffectedPopulationCell('   ')).toEqual({ ok: true, value: null });
    });

    // Excel hands back all three of these for what somebody typed as twelve
    // thousand. Number() alone chokes on the first two.
    it('accepts the shapes a spreadsheet produces for one number', () => {
      expect(parseAffectedPopulationCell('12,000')).toEqual({ ok: true, value: 12000 });
      expect(parseAffectedPopulationCell('12 000')).toEqual({ ok: true, value: 12000 });
      expect(parseAffectedPopulationCell('12000.0')).toEqual({ ok: true, value: 12000 });
    });

    // Reported as a row error rather than imported as null: a typo silently
    // becoming a blank is indistinguishable from "we never asked", which is the
    // exact ambiguity this column exists to remove.
    it('rejects anything that is not a whole count of people', () => {
      for (const bad of ['many', '-5', '12.5', '1e5']) {
        expect(parseAffectedPopulationCell(bad).ok).toBe(false);
      }
    });

    it('rejects an implausibly large figure, which is a mistyped digit run', () => {
      expect(parseAffectedPopulationCell('999999999').ok).toBe(false);
    });

    it('accepts zero — a recorded need that turned out to affect nobody', () => {
      expect(parseAffectedPopulationCell('0')).toEqual({ ok: true, value: 0 });
    });
  });
});
