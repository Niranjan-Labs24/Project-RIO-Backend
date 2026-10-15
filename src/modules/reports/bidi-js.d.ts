declare module "bidi-js" {
  export interface EmbeddingLevelsResult {
    levels: Uint8Array;
    paragraphs: Array<{ start: number; end: number; level: number }>;
  }
  export interface BidiJs {
    getEmbeddingLevels(text: string, explicitDirection?: "ltr" | "rtl"): EmbeddingLevelsResult;
    getMirroredCharacter(char: string): string | null;
    getReorderedString(text: string, levelsResult: EmbeddingLevelsResult, start?: number, end?: number): string;
    getReorderSegments(
      text: string,
      levelsResult: EmbeddingLevelsResult,
      start?: number,
      end?: number,
    ): Array<[number, number]>;
    getReorderedIndices(text: string, levelsResult: EmbeddingLevelsResult, start?: number, end?: number): number[];
  }
  export default function bidiFactory(): BidiJs;
}
