import { type ComponentType, useEffect, useMemo, useRef } from "react";
import { useRendererHost, useUiHost } from "../../../ui";
import { OpenTuiDataTable } from "./opentui";
import type {
  DataTableColumn,
  DataTableProps,
} from "./types";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { remoteNumberValue, resolveRemoteItemIndex } from "../../../remote/semantic-helpers";
import { useOptionalPaneInstanceId } from "../../../state/app/context";
import { registerPaneTableExporter } from "../../../state/pane-table-export-registry";
import { createDataTableCsv } from "../../data-table/export";
import { headerCase } from "../header-case";

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
  const paneId = useOptionalPaneInstanceId();
  const renderer = useRendererHost();
  const propsRef = useRef(props);
  propsRef.current = props;
  // The semantic snapshot can be taken every frame; the rows are rebuilt only when what they are drawn from changes.
  const reportedRowsRef = useRef<{ source: readonly unknown[]; rows: ReturnType<typeof reportedRows> } | null>(null);

  useEffect(() => {
    if (!paneId || !renderer.saveTextFile) return;
    return registerPaneTableExporter(paneId, (filename) => renderer.saveTextFile!({
      name: filename,
      text: createDataTableCsv(propsRef.current),
      mimeType: "text/csv;charset=utf-8",
    }));
  }, [paneId, renderer]);

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
          props.onHeaderClick?.(columnId);
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
    getMetadata: () => ({
      paneInstanceId: paneId,
      sortColumnId: props.sortColumnId,
      sortDirection: props.sortDirection,
      columns: props.columns.map((column) => ({ id: column.id, label: column.label })),
      rowCount: props.items.length,
      selectedId: firstSelectedId(props),
      ...(props.reportEveryRow ? { rows: cachedReportedRows(props, reportedRowsRef) } : {}),
    }),
  });
  // Header labels read the same in every table whatever case a pane wrote
  // them in. Exports and automation keep the pane's own labels.
  const columns = useMemo(
    () => props.columns.map((column) => {
      const label = headerCase(column.label);
      return label === column.label ? column : { ...column, label };
    }),
    [props.columns],
  );
  const HostDataTable = useUiHost().DataTable as
    | ComponentType<DataTableProps<T, C>>
    | undefined;
  if (HostDataTable) {
    return <HostDataTable {...props} columns={columns} />;
  }
  return <OpenTuiDataTable {...props} columns={columns} />;
}

function resolveTableIndex<T, C extends DataTableColumn>(
  input: unknown,
  props: DataTableProps<T, C>,
): number {
  // `id` reads the same key the snapshot publishes as `selectedId`.
  const key = (item: T, index: number) => props.getItemKey(item, index);
  return resolveRemoteItemIndex(input, props.items, { id: key, key });
}

/**
 * Every row as a report reads it: the key, whether it is selected and each
 * column's text, the same text the cells draw. Captured with the semantic
 * snapshot, so a row scrolled out of the viewport still reaches the report.
 */
function reportedRows<T, C extends DataTableColumn>(props: DataTableProps<T, C>) {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  return props.items.map((item, index) => {
    const selected = props.isSelected(item, index);
    const section = props.renderSectionHeader?.(item, index);
    const cells = section
      ? [{ columnLabel: "Row", text: normalize(section.text) }]
      : props.columns.map((column) => ({
        columnId: column.id,
        columnLabel: column.label,
        text: normalize(props.renderCell(item, column, index, { selected }).text),
      }));
    return { key: props.getItemKey(item, index), selected, cells: cells.filter((cell) => cell.text.length > 0) };
  });
}

function cachedReportedRows<T, C extends DataTableColumn>(
  props: DataTableProps<T, C>,
  cache: { current: { source: readonly unknown[]; rows: ReturnType<typeof reportedRows> } | null },
) {
  const source = [props.items, props.columns, props.renderCell, props.isSelected, props.renderSectionHeader];
  const cached = cache.current;
  if (cached && cached.source.length === source.length && cached.source.every((value, index) => value === source[index])) {
    return cached.rows;
  }
  const rows = reportedRows(props);
  cache.current = { source, rows };
  return rows;
}

function firstSelectedId<T, C extends DataTableColumn>(props: DataTableProps<T, C>): string | null {
  const index = props.items.findIndex((item, itemIndex) => props.isSelected(item, itemIndex));
  const item = props.items[index];
  if (item === undefined) return null;
  return props.getItemKey(item, index);
}
