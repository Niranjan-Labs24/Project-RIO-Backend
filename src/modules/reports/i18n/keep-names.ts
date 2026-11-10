// UAT GEN-03 — names as entered (study titles, organisation and people's names)
// are never machine-translated, in any report or export. A string that IS a
// name is left alone; inside a longer string each name is swapped for a
// placeholder the translator copies through, then put back unchanged.

export interface NameMask {
  /** True when the whole string is one of the names. */
  isName(text: string): boolean;
  /** The text the translator should see, with every name replaced by a placeholder. */
  mask(text: string): { text: string; count: number };
  /** The translation with every name put back, or null if a placeholder was lost. */
  unmask(source: string, translated: string): string | null;
}

const token = (i: number): string => `⟦${i}⟧`;

export function nameMask(keepNames: readonly string[] = []): NameMask {
  const names = [...new Set(keepNames.map((n) => n.trim()).filter((n) => n.length > 1))]
    // Longest first, so "Al Noor Society Riyadh" is masked before "Al Noor".
    .sort((a, b) => b.length - a.length);
  const used = (text: string): string[] => names.filter((n) => text.includes(n));
  const apply = (text: string, list: string[]): string =>
    list.reduce((out, name, i) => out.split(name).join(token(i)), text);
  return {
    isName: (text) => names.includes(text.trim()),
    mask(text) {
      const list = used(text);
      return { text: apply(text, list), count: list.length };
    },
    unmask(source, translated) {
      const list = used(source);
      let out = translated;
      for (let i = 0; i < list.length; i++) {
        if (!out.includes(token(i))) return null;
        out = out.split(token(i)).join(list[i]);
      }
      return out;
    },
  };
}

/** What remains of a masked string once its placeholders are removed. */
export const withoutNames = (masked: string): string => masked.replace(/⟦\d+⟧/g, "");
