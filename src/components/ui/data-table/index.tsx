import { type ComponentType } from "react";
import { useUiHost } from "../../../ui";
import { OpenTuiDataTable } from "./opentui";
import type {
  DataTableColumn,
  DataTableProps,
} from "./types";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { remoteNumberValue, resolveRemoteItemIndex } from "../../../remote/semantic-helpers";

export type {
  DataTableCell,
  DataTableColumn,
  DataTableProps,
  DataTableSectionHeader,
  DataTableVisibleRange,
} from "./types";

export function DataTable<T, C extends DataTableColumn = DataTableColumn>(
  props: DataTableProps<T, C>,
) {
  useRemoteUiNode({
    role: "table",
    label: "Data table",
    actions: {
      selectRow: (input) => {
        const index = resolveTableIndex(input, props);
        const item = index >= 0 ? props.items[index] : undefined;
        if (item) props.onSelect(item, index);
      },
      activateRow: (input) => {
        const index = resolveTableIndex(input, props);
        const item = index >= 0 ? props.items[index] : undefined;
        if (item) {
          props.onSelect(item, index);
          props.onActivate?.(item, index);
        }
      },
      sort: (input) => {
        const columnId = typeof input === "string"
          ? input
          : input && typeof input === "object" && typeof (input as { columnId?: unknown }).columnId === "string"
            ? (input as { columnId: string }).columnId
            : null;
        if (columnId && props.columns.some((column) => column.id === columnId)) {
          props.onHeaderClick(columnId);
        }
      },
      scrollTo: (input) => {
        const box = props.scrollRef.current;
        if (!box) return;
        box.scrollTo(Math.max(0, Math.round(remoteNumberValue(input, ["top", "index"]))));
        props.onBodyScrollActivity();
      },
      scrollBy: (input) => {
        const box = props.scrollRef.current;
        if (!box) return;
        const direction = input && typeof input === "object"
          ? (input as { direction?: unknown }).direction
          : undefined;
        const delta = direction === "up"
          ? remoteNumberValue(input, ["delta"], -1)
          : remoteNumberValue(input, ["delta"], 1);
        box.scrollTo(Math.max(0, Math.round((box.scrollTop ?? 0) + delta)));
        props.onBodyScrollActivity();
      },
    },
    metadata: {
      sortColumnId: props.sortColumnId,
      sortDirection: props.sortDirection,
      columns: props.columns.map((column) => ({ id: column.id, label: column.label })),
      rows: props.items.slice(0, 200).map((item, index) => ({
        index,
        key: props.getItemKey(item, index),
        selected: props.isSelected(item, index),
      })),
      rowCount: props.items.length,
    },
  });
  const HostDataTable = useUiHost().DataTable as
    | ComponentType<DataTableProps<T, C>>
    | undefined;
  if (HostDataTable) {
    return <HostDataTable {...props} />;
  }
  return <OpenTuiDataTable {...props} />;
}

function resolveTableIndex<T, C extends DataTableColumn>(
  input: unknown,
  props: DataTableProps<T, C>,
): number {
  return resolveRemoteItemIndex(input, props.items, {
    key: (item, index) => props.getItemKey(item, index),
  });
}
