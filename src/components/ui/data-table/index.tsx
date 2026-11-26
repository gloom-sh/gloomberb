import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRendererHost, useUiHost } from "../../../ui";
import { OpenTuiDataTable } from "./opentui";
import type {
  DataTableColumn,
  DataTableProps,
  DataTableVisibleRange,
} from "./types";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { remoteNumberValue, resolveRemoteRowIndex } from "../../../remote/semantic-helpers";
import { useOptionalPaneInstanceId } from "../../../state/app/context";
import { registerPaneTableExporter } from "../../../state/pane-table-export-registry";
import { createDataTableCsv } from "../../data-table/export";
import { headerCase } from "../header-case";
import { tPlugin } from "../../../i18n";
import { useTranslationRevision } from "../../../i18n/react";
import { figureColumnCells } from "./render-cell";
import { mutedRowCells } from "./muted-row";
import { useDataTableColumnOrder } from "./use-column-order";
import { dataTableDisplayColumns } from "./display-columns";
import { sameVisibleRange } from "./visible-range";
import { useDataTableColumnFit } from "./column-fit";
import { isAsOfColumn, markHiddenTableColumns } from "../table-layout";

export type {
  DataTableCell,
  DataTableColumn,
  DataTableColumnFit,
  DataTableColumnReorder,
  DataTableProps,
  DataTableRowSource,
  DataTableSectionHeader,
  DataTableVisibleRange,
} from "./types";

export function DataTable<T, C extends DataTableColumn = DataTableColumn>(
  ownProps: DataTableProps<T, C>,
) {
  // Every renderer, report and export reads the cells through this, so a column of figures lines up everywhere.
  const drawnCell = useMemo(
    () => mutedRowCells(figureColumnCells(ownProps.renderCell), ownProps.isRowMuted),
    [ownProps.isRowMuted, ownProps.renderCell],
  );
  // A row source's reports and exports read each row's current data; a row on screen is drawn from it already.
  const renderCell = useMemo((): DataTableProps<T, C>["renderCell"] => {
    const source = ownProps.rowSource;
    return source ? (item, column, index, state) => drawnCell(source.read(item) ?? item, column, index, state) : drawnCell;
  }, [drawnCell, ownProps.rowSource]);
  // A caller that already ordered the columns (`DataTableView`) passes the move it resolved.
  const order = useDataTableColumnOrder(ownProps.columns, ownProps.onColumnMove ? false : ownProps.columnReorder);
  const exportIdentity = useMemo(() => {
    if (!ownProps.exportIdentity || !ownProps.rowSource) return ownProps.exportIdentity;
    const identity = ownProps.exportIdentity;
    const source = ownProps.rowSource;
    return { ...identity, cells: (item: T) => identity.cells(source.read(item)) };
  }, [ownProps.exportIdentity, ownProps.rowSource]);
  const props = {
    ...ownProps,
    renderCell,
    exportIdentity,
    // Exports and reports read the columns in the order the reader sees them.
    columns: order.columns,
    onColumnMove: ownProps.onColumnMove ?? order.onColumnMove,
    anchoredColumns: ownProps.onColumnMove ? ownProps.anchoredColumns : order.anchoredColumns,
  };
  const [visibleRange, setVisibleRange] = useState<DataTableVisibleRange | null>(null);
  const onVisibleRangeChange = useCallback((range: DataTableVisibleRange) => {
    // A viewport not laid out yet reports no rows: it would hide every in-view
    // column for a frame, so the columns wait for a range with rows in it.
    if (range.end > range.start) setVisibleRange((previous) => previous && sameVisibleRange(previous, range) ? previous : range);
    ownProps.onVisibleRangeChange?.(range);
  }, [ownProps.onVisibleRangeChange]);
  const shownColumns = useMemo(() => dataTableDisplayColumns(props, visibleRange),
    [props.columns, props.items, props.renderCell, props.renderSectionHeader, props.isSelected, visibleRange]);
  // Only the drawn headers use translated labels. Exports and automation keep the raw columns.
  const translationRevision = useTranslationRevision(shownColumns.some((column) => column.labelTranslation));
  // The columns as their headers read: translated where a column opted in, in the table's one case. A header wider
  // than its column widens it, so the fit below measures these and not the raw labels.
  const headerColumns = useMemo(() => shownColumns.map((column) => {
    const translation = column.labelTranslation;
    const label = headerCase(translation ? tPlugin(translation.pluginId, translation.key, column.label) : column.label);
    return label === column.label ? column : { ...column, label };
  }), [shownColumns, translationRevision]);
  // The fit narrows a column into a copy of it and the header's label is one too: from here on a column is known
  // by its id, never by being the same object.
  const shownIds = useMemo(() => new Set(shownColumns.map((column) => column.id)), [shownColumns]);
  // Where the renderer cuts a column at its edge, the columns that fit its width: whole columns leave, least needed first.
  const columnFit = useDataTableColumnFit(headerColumns, {
    anchoredColumns: props.columns.slice(0, props.anchoredColumns ?? 1).filter((column) => shownIds.has(column.id)).length,
    sortColumnId: props.sortColumnId,
    scrollsSideways: props.showHorizontalScrollbar !== false,
    dropOrder: props.columnDropOrder,
    asOfColumnIds: useMemo(() => shownColumns.filter(isAsOfColumn).map((column) => column.id), [shownColumns]),
    columnGap: props.columnGap,
    horizontalPadding: props.horizontalPadding,
  });
  const columnFitRef = ownProps.columnFitRef;
  if (columnFitRef) columnFitRef.current = columnFit.fit;
  useEffect(() => () => { if (columnFitRef) columnFitRef.current = null; }, [columnFitRef]);
  // The columns on screen as the pane gave them, raw label and set width, for what reads the table and not its picture.
  const displayColumns = useMemo(() => {
    const fitted = columnFit.fitted;
    return fitted ? shownColumns.filter((column) => fitted.ids.has(column.id)) : shownColumns;
  }, [columnFit.fitted, shownColumns]);
  const displayIds = useMemo(() => new Set(displayColumns.map((column) => column.id)), [displayColumns]);
  const reportProps = {
    ...props,
    columns: displayColumns,
    // Every column not on screen, once: a report reads each id in one cell a row.
    reportColumns: useMemo(() => [
      ...props.columns.filter((column) => !displayIds.has(column.id)),
      ...props.reportColumns ?? [],
    ], [props.columns, displayIds, props.reportColumns]),
  };
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
      text: propsRef.current.exportCsv?.() ?? createDataTableCsv(propsRef.current.exportItems
        ? { ...propsRef.current, items: propsRef.current.exportItems }
        : propsRef.current),
      mimeType: "text/csv;charset=utf-8",
    }), () => propsRef.current.exportName);
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
      columns: displayColumns.map((column) => ({ id: column.id, label: column.label, ...(column.mayBeBlank ? { mayBeBlank: true } : {}) })),
      rowCount: props.items.length,
      selectedId: firstSelectedId(props),
      ...(props.reportEveryRow ? { rows: ownProps.rowSource ? reportedRows(reportProps) : cachedReportedRows(reportProps, reportedRowsRef) } : {}),
    }),
    // Read for this table alone: a confirmation names the row a call would open.
    getDetail: () => ({ rows: ownProps.rowSource ? reportedRows(reportProps) : cachedReportedRows(reportProps, reportedRowsRef) }),
  });
  // What the renderer draws: the headers as they read, the fit's columns at the widths it narrowed them to, and the
  // ones it left out named above the header as their headers would read, for its More to draw again.
  const columns = useMemo(() => {
    const fitted = columnFit.fitted;
    if (!fitted) return headerColumns;
    const drawn = headerColumns.filter((column) => fitted.ids.has(column.id))
      .map((column) => fitted.widths.has(column.id) ? { ...column, width: fitted.widths.get(column.id)! } : column);
    return markHiddenTableColumns(headerColumns, drawn, { restorable: true });
  }, [columnFit.fitted, headerColumns]);
  const HostDataTable = useUiHost().DataTable as
    | ComponentType<DataTableProps<T, C>>
    | undefined;
  const displayProps = {
    ...props,
    renderCell: drawnCell,
    columns,
    anchoredColumns: props.anchoredColumns == null ? undefined
      : props.columns.slice(0, props.anchoredColumns).filter((column) => displayIds.has(column.id)).length,
    // A drag lands on a drawn column, which may be a narrowed copy: it is found among the table's own by id.
    onColumnMove: props.onColumnMove ? (columnId: string, toIndex: number) => {
      const target = columns[toIndex];
      const index = target ? props.columns.findIndex((column) => column.id === target.id) : -1;
      if (index >= 0) props.onColumnMove?.(columnId, index);
    } : undefined,
    onVisibleRangeChange: props.columns.some((column) => column.omitWhenEmpty === "visible")
      ? onVisibleRangeChange : props.onVisibleRangeChange,
    onViewportWidthChange: columnFit.onViewportWidthChange,
    onShowAllColumns: columnFit.fit.hidden > 0 ? columnFit.fit.showAll : undefined,
    scrollToColumn: columnFit.scrollToColumn,
  };
  if (HostDataTable) {
    return <HostDataTable {...displayProps} />;
  }
  return <OpenTuiDataTable {...displayProps} />;
}

function resolveTableIndex<T, C extends DataTableColumn>(
  input: unknown,
  props: DataTableProps<T, C>,
): number {
  // `id` reads the same key the snapshot publishes as `selectedId`.
  return resolveRemoteRowIndex(input, props.items, (item, index) => props.getItemKey(item, index));
}

/**
 * Every row as a report reads it: the key, whether it is selected and each
 * column's text, the same text the cells draw. Captured with the semantic
 * snapshot, so a row scrolled out of the viewport still reaches the report.
 * A section header sits in the first column and a time cell carries the
 * instant behind its short text, as the capture of a drawn row reads them.
 */
function reportedRows<T, C extends DataTableColumn>(props: DataTableProps<T, C>) {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const first = props.columns[0];
  return props.items.map((item, index) => {
    const selected = props.isSelected(item, index);
    const section = props.renderSectionHeader?.(item, index);
    const cells = section
      ? [{
        ...(first ? { columnId: first.id } : {}),
        columnLabel: first?.label ?? "Row",
        text: normalize(section.action ? `${section.text} ${section.action.label}` : section.text),
      }]
      : [...props.columns, ...props.reportColumns ?? []].map((column, columnIndex) => {
        const cell = props.renderCell(item, column, index, { selected });
        return {
          columnId: column.id,
          columnLabel: column.label,
          text: normalize(cell.text),
          ...(cell.value instanceof Date && Number.isFinite(cell.value.getTime()) ? { instant: cell.value.toISOString() } : {}),
          ...(typeof cell.value === "number" && Number.isFinite(cell.value) ? { value: cell.value } : {}),
          // Read by the JSON and CSV, never drawn or printed as text.
          ...(columnIndex >= props.columns.length ? { reportOnly: true } : {}),
        };
      });
    // A section header (FUT's sector) is marked, so a count of the table's rows can leave it out.
    return { key: props.getItemKey(item, index), selected, ...(section ? { section: true } : {}),
      cells: cells.filter((cell) => cell.text.length > 0) };
  });
}

function cachedReportedRows<T, C extends DataTableColumn>(
  props: DataTableProps<T, C>,
  cache: { current: { source: readonly unknown[]; rows: ReturnType<typeof reportedRows> } | null },
) {
  const source = [props.items, props.columns, props.reportColumns, props.renderCell, props.isSelected, props.renderSectionHeader];
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
