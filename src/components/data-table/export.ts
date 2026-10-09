import type { DataTableCell, DataTableColumn, DataTableProps } from "../ui";
import { serializeCsv } from "../../utils/csv";
import {
  BLANK_DISPLAY as BLANK,
  DISPLAY_PLACEHOLDER as PLACEHOLDER,
  labelWithUnit,
  parseDisplayNumber,
} from "../../utils/display-number";

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
