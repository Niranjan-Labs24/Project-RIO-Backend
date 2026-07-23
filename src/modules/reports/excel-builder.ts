import ExcelJS from "exceljs";
import type { FlattenedContent } from "./report-content-flatten";

export async function buildPlaceholderExcel(
  title: string,
  reportType: string,
  content: FlattenedContent,
  metaRows: Array<{ field: string; value: string }> = [],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "RIO";
  workbook.created = new Date();

  const summarySheet = workbook.addWorksheet("Summary");
  summarySheet.columns = [
    { header: "Field", key: "field", width: 32 },
    { header: "Value", key: "value", width: 60 },
  ];
  summarySheet.getRow(1).font = { bold: true };
  summarySheet.addRow({ field: "Report", value: title });
  summarySheet.addRow({ field: "Report Type", value: reportType });
  for (const row of metaRows) summarySheet.addRow(row);
  for (const row of content.summaryRows) summarySheet.addRow(row);

  for (const table of content.tables) {
    const sheetName = table.name.slice(0, 31);
    const sheet = workbook.addWorksheet(sheetName);
    const columnKeys = Array.from(new Set(table.rows.flatMap((row) => Object.keys(row))));
    sheet.columns = columnKeys.map((key) => ({ header: key, key, width: 24 }));
    sheet.getRow(1).font = { bold: true };
    for (const row of table.rows) sheet.addRow(row);
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
