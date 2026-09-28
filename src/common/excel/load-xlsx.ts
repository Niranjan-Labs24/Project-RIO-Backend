import type ExcelJS from 'exceljs';

/**
 * ExcelJS declares its own `Buffer` type that Node's `Buffer` is not assignable
 * to, although it is exactly what the library reads. Loading goes through here
 * so that mismatch is handled once.
 */
export async function loadXlsx(workbook: ExcelJS.Workbook, buffer: Buffer | Uint8Array): Promise<void> {
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
}
