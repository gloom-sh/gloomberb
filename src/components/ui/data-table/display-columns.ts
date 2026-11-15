import { MISSING_VALUE } from "../../../utils/format";
import type { DataTableColumn, DataTableProps, DataTableVisibleRange } from "./types";

export function dataTableDisplayColumns<T, C extends DataTableColumn>(
  props: Pick<DataTableProps<T, C>, "columns" | "items" | "renderCell" | "renderSectionHeader" | "isSelected">,
  visibleRange?: DataTableVisibleRange | null,
): C[] {
  if (!props.columns.some((column) => column.omitWhenEmpty)) return props.columns;
  return props.columns.filter((column) => !column.omitWhenEmpty || props.items.some((item, index) => {
    if (column.omitWhenEmpty === "visible" && visibleRange && (index < visibleRange.start || index >= visibleRange.end)) return false;
    if (props.renderSectionHeader?.(item, index)) return false;
    const cell = props.renderCell(item, column, index, { selected: props.isSelected(item, index) });
    const text = cell.text.trim();
    return text !== "" && text !== MISSING_VALUE;
  }));
}
