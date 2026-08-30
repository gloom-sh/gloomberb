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
}: Pick<DataTableProps<T, C>, "columns" | "items" | "renderCell" | "renderSectionHeader">): string {
  const rows = items.flatMap((item, index) => {
    if (renderSectionHeader?.(item, index)) return [];
    return [columns.map((column) => renderCell(item, column, index, { selected: false }).text)];
  });
  return serializeCsv([
    columns.map((column) => column.label),
    ...rows,
  ], { excelCompatible: true });
}
