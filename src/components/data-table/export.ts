import type { DataTableColumn, DataTableProps } from "../ui";
import { serializeCsv } from "../../utils/csv";

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
  const kept = columns.flatMap((column, index) => (
    cells.length && cells.every((row) => row[index]!.content != null && !row[index]!.text) ? [] : [index]
  ));
  const metadata = getExportMetadata?.() ?? [];
  return serializeCsv([
    kept.map((index) => columns[index]!.label),
    ...cells.map((row) => kept.map((index) => row[index]!.text)),
    ...(metadata.length ? [[], ...metadata] : []),
  ], { excelCompatible: true });
}
