export const EXCEL_CSV_BOM = "\uFEFF";

/**
 * A number as a spreadsheet reads it: optional sign, digits with or without
 * thousands commas, decimals, an exponent and a trailing percent.
 */
const NUMERIC_TEXT = /^[+-]?(?=\.?\d)(?:\d{1,3}(?:,\d{3})+|\d*)(?:\.\d+)?(?:e[+-]?\d+)?%?$/i;

/**
 * Excel and Sheets run a cell that starts with one of these as a formula.
 * Leading spaces do not stop them.
 */
const FORMULA_START = /^(?:[\t\r]| *[=+\-@])/;

function isNumericCsvText(text: string): boolean {
  return NUMERIC_TEXT.test(text.trim());
}

function normalizeCsvCell(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function escapeCsvCell(value: unknown, excelCompatible: boolean): string {
  const normalized = normalizeCsvCell(value);
  // A signed number is data, not a formula: "-2.10" must stay a number.
  const text = excelCompatible && FORMULA_START.test(normalized) && !isNumericCsvText(normalized)
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
