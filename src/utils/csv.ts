export const EXCEL_CSV_BOM = "\uFEFF";

function normalizeCsvCell(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function escapeCsvCell(value: unknown, excelCompatible: boolean): string {
  const normalized = normalizeCsvCell(value);
  const text = excelCompatible && /^[\t\r ]*[=+\-@]/.test(normalized)
    ? `'${normalized}`
    : normalized;
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function serializeCsv(
  rows: readonly (readonly unknown[])[],
  options: { excelCompatible?: boolean } = {},
): string {
  const excelCompatible = options.excelCompatible === true;
  const csv = rows.map((row) => row.map((cell) => escapeCsvCell(cell, excelCompatible)).join(",")).join("\n");
  return excelCompatible ? `${EXCEL_CSV_BOM}${csv}` : csv;
}

export function createCsvExportFilename(title: string): string {
  const stem = title.trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[. -]+|[. -]+$/g, "")
    .slice(0, 80) || "gloomberb-table";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stem}-${timestamp}.csv`;
}
