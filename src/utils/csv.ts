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

/**
 * The decimal mark a CSV writes its numbers with. `comma` is what a
 * spreadsheet set to a decimal-comma locale (German, French, Brazilian) reads
 * as a number: `17,2`, never the date `17.2` becomes. Its cells are then
 * separated by `;`, as those spreadsheets read them, so a decimal comma never
 * splits a cell. Text, dates and JSON are never changed.
 */
export type CsvDecimal = "dot" | "comma";

let defaultDecimal: CsvDecimal = "dot";

/**
 * The decimal mark every CSV is written with unless the caller names one:
 * the `csvDecimal` setting, or `--decimal` for one command. Null or absent is
 * the dot.
 */
export function setCsvDecimal(decimal: CsvDecimal | null | undefined): void {
  defaultDecimal = decimal === "comma" ? "comma" : "dot";
}

/** The decimal mark CSVs are written with now (setCsvDecimal). */
export function csvDecimal(): CsvDecimal {
  return defaultDecimal;
}

/** The cell separator that goes with a decimal mark: `;` beside a decimal comma, `,` beside a dot. */
function csvSeparator(decimal: CsvDecimal = defaultDecimal): string {
  return decimal === "comma" ? ";" : ",";
}

/** `1,234.5` and `-0.07%` as a decimal-comma spreadsheet reads them: `1234,5` and `-0,07%`. Other text stays. */
function withDecimalComma(text: string): string {
  if (!isNumericCsvText(text)) return text;
  return text.trim().replace(/,/g, "").replace(".", ",");
}

function escapeCsvCell(value: unknown, excelCompatible: boolean, decimal: CsvDecimal): string {
  const normalized = normalizeCsvCell(value);
  // A signed number is data, not a formula: "-2.10" must stay a number.
  const guarded = excelCompatible && FORMULA_START.test(normalized) && !isNumericCsvText(normalized)
    ? `'${normalized}`
    : normalized;
  const text = decimal === "comma" && (typeof value === "number" || typeof value === "string") ? withDecimalComma(guarded) : guarded;
  const separator = csvSeparator(decimal);
  if (!text.includes(separator) && !/["\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function serializeCsv(
  rows: readonly (readonly unknown[])[],
  options: { excelCompatible?: boolean; decimal?: CsvDecimal } = {},
): string {
  const excelCompatible = options.excelCompatible === true;
  const decimal = options.decimal ?? defaultDecimal;
  const csv = rows.map((row) => row.map((cell) => escapeCsvCell(cell, excelCompatible, decimal)).join(csvSeparator(decimal))).join("\n");
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
