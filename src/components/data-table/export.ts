import type { DataTableCell, DataTableColumn, DataTableProps } from "../ui";
import { serializeCsv } from "../../utils/csv";

/** What a cell draws for a missing value: a dash, a run of dashes, or the loading ellipsis. */
const PLACEHOLDER = /^(?:[-\u2013\u2014]{1,3}|\u2026|\.\.\.)$/;

/**
 * A number as a table draws it: sign, currency symbol, thousands commas,
 * decimals, a compact scale (12.3k, 1.20B) and a unit (%, x, bp, USD).
 */
const DISPLAY_NUMBER = /^([+-]?)([A-Z]{0,3}[$\u20ac\u00a3\u00a5\u20b9\u20a9\u20bd\u20ba\u20aa\u20ab\u0e3f])?(?=\.?\d)(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d+))?([kKMBT])?(%|x| ?bps?| [A-Z]{3})?$/;

const SCALE_DIGITS: Record<string, number> = { k: 3, K: 3, M: 6, B: 9, T: 12 };

interface DisplayNumber {
  /** Plain decimal text: no sign for positives, no commas, no scale letter. */
  number: string;
  /** What the column header has to name once the cells are bare numbers. */
  unit: string;
}

const BLANK = "blank";

/** Moves the decimal point right without going through a float, so 1.23B is exactly 1230000000. */
function scaleDecimal(integer: string, fraction: string, digits: number): string {
  const whole = `${integer}${fraction.padEnd(digits, "0").slice(0, digits)}`.replace(/^0+(?=\d)/, "") || "0";
  const rest = fraction.slice(digits);
  return rest ? `${whole}.${rest}` : whole;
}

function parseDisplayNumber(text: string): DisplayNumber | typeof BLANK | null {
  // A direction arrow beside a signed move repeats the sign.
  const trimmed = text.trim().replace(/\u2212/g, "-").replace(/\s*[\u2191\u2193]$/, "");
  if (!trimmed || PLACEHOLDER.test(trimmed)) return BLANK;
  const match = DISPLAY_NUMBER.exec(trimmed);
  if (!match) return null;
  const [, sign, currency = "", grouped, fraction = "", scale, unitText = ""] = match;
  const integer = grouped!.replace(/,/g, "") || "0";
  const digits = scale ? SCALE_DIGITS[scale]! : 0;
  const magnitude = digits ? scaleDecimal(integer, fraction, digits) : fraction ? `${integer}.${fraction}` : integer;
  const unit = unitText.trim().replace(/^bps$/, "bp");
  return { number: `${sign === "-" ? "-" : ""}${magnitude}`, unit: [currency, unit].filter(Boolean).join(" ") };
}

/** Adds the unit the cells dropped, unless the header already names it. */
function labelWithUnit(label: string, unit: string): string {
  if (!unit) return label;
  // A word unit has to stand alone: "Max" does not name x.
  const named = unit === "bp" ? /\bbps?\b/i.test(label)
    : /^[A-Za-z]+$/.test(unit) ? new RegExp(`\\b${unit}\\b`, "i").test(label)
      : label.includes(unit);
  return named ? label : `${label} (${unit})`;
}

function rawExportValue(value: NonNullable<DataTableCell["value"]> | null): unknown {
  if (value == null) return "";
  // 15 significant digits is what a spreadsheet keeps, and it drops float noise (0.0345 * 100).
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toPrecision(15)) : "";
  return value;
}

/**
 * A right-aligned column whose cells all read as numbers in one unit exports
 * bare numbers and moves the unit into the header. Anything else exports what
 * the cell shows. A cell's own `value` wins over both.
 */
function exportColumn(column: DataTableColumn, cells: readonly DataTableCell[]): { label: string; values: unknown[] } {
  const label = column.label.trim();
  const shown = (cell: DataTableCell) => cell.value !== undefined
    ? rawExportValue(cell.value)
    : PLACEHOLDER.test(cell.text.trim()) ? "" : cell.text;
  if (column.align !== "right") return { label, values: cells.map(shown) };

  const parsed = cells.map((cell) => parseDisplayNumber(cell.text));
  const units = new Set(parsed.flatMap((entry) => entry && entry !== BLANK ? [entry.unit] : []));
  // One cell the parser cannot read, or two units, and the header cannot name the unit.
  if (parsed.includes(null) || units.size > 1) return { label, values: cells.map(shown) };
  return {
    label: labelWithUnit(label, [...units][0] ?? ""),
    values: cells.map((cell, index) => {
      if (cell.value !== undefined) return rawExportValue(cell.value);
      const entry = parsed[index]!;
      return entry === BLANK ? "" : entry.number;
    }),
  };
}

/** The as-of line leads the notes under the table, so a reader sees when the data is from first. */
function orderMetadata(rows: readonly (readonly unknown[])[]): readonly (readonly unknown[])[] {
  const isAsOf = (row: readonly unknown[]) => typeof row[0] === "string" && /^as of\b/i.test(row[0].trim());
  return [...rows.filter(isAsOf), ...rows.filter((row) => !isAsOf(row))];
}

export function createDataTableCsv<
  T,
  C extends DataTableColumn = DataTableColumn,
>({
  columns,
  items,
  renderCell,
  renderSectionHeader,
  getExportMetadata,
}: Pick<DataTableProps<T, C>, "columns" | "items" | "renderCell" | "renderSectionHeader" | "getExportMetadata">): string {
  const cells = items.flatMap((item, index) => {
    if (renderSectionHeader?.(item, index)) return [];
    return [columns.map((column) => renderCell(item, column, index, { selected: false }))];
  });
  // A column drawn only as graphics (a bar, a sparkline) has no value to export.
  const exported = columns.flatMap((column, index) => (
    cells.length && cells.every((row) => row[index]!.content != null && !row[index]!.text && row[index]!.value === undefined)
      ? []
      : [exportColumn(column, cells.map((row) => row[index]!))]
  ));
  const metadata = orderMetadata(getExportMetadata?.() ?? []);
  // Notes go under the table after a blank row, so the first line stays the header.
  return serializeCsv([
    exported.map((column) => column.label),
    ...cells.map((_, row) => exported.map((column) => column.values[row])),
    ...(metadata.length ? [[], ...metadata] : []),
  ], { excelCompatible: true });
}
